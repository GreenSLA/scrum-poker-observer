// Unit tests: node --test tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Core = require(path.join(__dirname, '..', 'extension', 'core.js'));
const { Mirror, pickCard, decide, sanitizeSettings, normalize } = Core;

const ROOM = '31699991';
const DECK = ['?', 'cof', '0', '0.5', '1', '2', '3', '5', '8', '13', '20', '40', '100'].map((value) => ({ value }));

// Replays what the page does when entering a room.
function syncedMirror(estimates, show) {
  const m = new Mirror();
  m.handle({ k: 'created', sid: 1 });
  m.handle({ k: 'uid', sid: 1, uid: 'ME' });
  m.handle({ k: 'listen', sid: 1, r: 16, p: `/scrumPoker/showEstimates/${ROOM}`, hasQuery: false });
  m.handle({ k: 'listen', sid: 1, r: 17, p: `/scrumPoker/estimates/${ROOM}`, hasQuery: false });
  m.handle({ k: 'push', sid: 1, a: 'd', p: `scrumPoker/estimates/${ROOM}`, d: estimates, t: null });
  m.handle({ k: 'push', sid: 1, a: 'd', p: `scrumPoker/showEstimates/${ROOM}`, d: show === undefined ? null : show, t: null });
  m.handle({ k: 'res', sid: 1, r: 16, s: 'ok' });
  m.handle({ k: 'res', sid: 1, r: 17, s: 'ok' });
  return m;
}

const people = (m) =>
  Object.fromEntries(m.room(ROOM).participants.map((p) => [p.uid, `${p.name}=${p.vote}`]));

test('mirror: snapshot, child set and merge with null', () => {
  const m = syncedMirror({ ME: { displayName: 'Alice', updatedAt: 1 }, B: { displayName: 'Bob', storyPoints: '5', updatedAt: 2 } });
  let r = m.room(ROOM);
  assert.equal(r.synced, true);
  assert.equal(r.revealed, false);
  assert.deepEqual(people(m), { ME: 'Alice=null', B: 'Bob=5' });

  m.handle({ k: 'push', sid: 1, a: 'd', p: `scrumPoker/estimates/${ROOM}/B`, d: { displayName: 'Bob', storyPoints: 'cof', updatedAt: 3 } });
  assert.deepEqual(people(m), { ME: 'Alice=null', B: 'Bob=cof' });

  // "Delete Estimates": update({storyPoints: null}) per participant.
  m.handle({ k: 'push', sid: 1, a: 'm', p: `scrumPoker/estimates/${ROOM}/B`, d: { storyPoints: null }, t: null });
  assert.deepEqual(people(m), { ME: 'Alice=null', B: 'Bob=null' });

  // Merge with nested relative paths.
  m.handle({ k: 'push', sid: 1, a: 'm', p: `scrumPoker/estimates/${ROOM}`, d: { 'B/storyPoints': '8', 'C/displayName': 'Carol' }, t: null });
  assert.deepEqual(people(m), { ME: 'Alice=null', B: 'Bob=8', C: 'Carol=null' });

  m.handle({ k: 'push', sid: 1, a: 'm', p: `scrumPoker/showEstimates/${ROOM}`, d: { showEstimates: true }, t: null });
  r = m.room(ROOM);
  assert.equal(r.revealed, true);
  assert.equal(r.revealSynced, true);

  // "Clear Room" removes the whole list.
  m.handle({ k: 'push', sid: 1, a: 'd', p: `scrumPoker/estimates/${ROOM}`, d: null, t: null });
  assert.deepEqual(m.room(ROOM).participants, []);
});

test('mirror: sync state follows listen / ok / unlisten / socket close', () => {
  const m = new Mirror();
  m.handle({ k: 'listen', sid: 1, r: 5, p: `/scrumPoker/estimates/${ROOM}`, hasQuery: false });
  m.handle({ k: 'push', sid: 1, a: 'd', p: `scrumPoker/estimates/${ROOM}`, d: { B: { displayName: 'Bob' } }, t: null });
  assert.equal(m.room(ROOM).synced, false, 'not synced before the server acknowledges the listen');
  m.handle({ k: 'res', sid: 1, r: 5, s: 'ok' });
  assert.equal(m.room(ROOM).synced, true);
  assert.deepEqual(m.listenedRooms(), [ROOM]);

  m.handle({ k: 'unlisten', sid: 1, r: 6, p: `/scrumPoker/estimates/${ROOM}`, hasQuery: false });
  assert.equal(m.room(ROOM).synced, false);

  m.handle({ k: 'listen', sid: 1, r: 7, p: `/scrumPoker/estimates/${ROOM}`, hasQuery: false });
  m.handle({ k: 'res', sid: 1, r: 7, s: 'ok' });
  assert.equal(m.room(ROOM).synced, true);

  m.handle({ k: 'close', sid: 1 });
  assert.equal(m.room(ROOM).synced, false);

  // A reconnect with matching hash gets "ok" without data: still in sync.
  m.handle({ k: 'listen', sid: 2, r: 3, p: `/scrumPoker/estimates/${ROOM}`, hasQuery: false });
  m.handle({ k: 'res', sid: 2, r: 3, s: 'ok' });
  assert.equal(m.room(ROOM).synced, true);
  assert.deepEqual(people(m), { B: 'Bob=null' });

  // Responses from another socket with the same request id do not count.
  m.handle({ k: 'listen', sid: 3, r: 9, p: '/scrumPoker/showEstimates/' + ROOM, hasQuery: false });
  m.handle({ k: 'res', sid: 2, r: 9, s: 'ok' });
  assert.equal(m.room(ROOM).revealSynced, false);
  m.handle({ k: 'res', sid: 3, r: 9, s: 'permission_denied' });
  assert.equal(m.room(ROOM).revealSynced, false);
});

test('mirror: tagged (filtered query) pushes and query listens are ignored', () => {
  const m = syncedMirror({ B: { displayName: 'Bob', storyPoints: '5' } });
  m.handle({ k: 'push', sid: 1, a: 'd', p: `scrumPoker/estimates/${ROOM}`, d: { X: { displayName: 'X' } }, t: 4 });
  assert.deepEqual(people(m), { B: 'Bob=5' });
  m.handle({ k: 'listen', sid: 1, r: 30, p: `/scrumPoker/estimates/${ROOM}`, hasQuery: true });
  m.handle({ k: 'res', sid: 1, r: 30, s: 'ok' });
  m.handle({ k: 'unlisten', sid: 1, p: `/scrumPoker/estimates/${ROOM}`, hasQuery: true });
  assert.equal(m.room(ROOM).synced, true);
});

test('normalize: firebase value conventions and hostile keys', () => {
  assert.equal(normalize({}), null);
  assert.equal(normalize({ '.value': '5', '.priority': 1 }), '5');
  const o = normalize({ a: { b: null }, c: 1, '.priority': 2 });
  assert.deepEqual(Object.keys(o), ['c']);
  const m = new Mirror();
  m.apply('scrumPoker/estimates/R', { __proto__x: 1, ['__proto__']: { displayName: 'evil' } }, false);
  assert.equal({}.displayName, undefined);
  m.apply('scrumPoker/estimates/R/__proto__/storyPoints', '5', false);
  assert.equal({}.storyPoints, undefined);
  assert.equal(Object.prototype.storyPoints, undefined);
});

test('pickCard: rounding modes', () => {
  const v = (avg, mode) => pickCard(DECK, avg, mode).value;
  assert.equal(v(5, 'nearest'), '5');
  assert.equal(v(5.33, 'nearest'), '5');
  assert.equal(v(6.5, 'nearest'), '8', 'tie goes up');
  assert.equal(v(6.5, 'down'), '5');
  assert.equal(v(5.0000000001, 'up'), '5', 'float noise is not rounded up');
  assert.equal(v(5.1, 'up'), '8');
  assert.equal(v(0.25, 'nearest'), '0.5', 'tie between 0 and 0.5 goes up');
  assert.equal(v(250, 'up'), '100', 'above the deck clamps to the max');
  assert.equal(v(-1, 'down'), '0', 'below the deck clamps to the min');
  const hours = ['1h', '2h', '4h', '8h', '?'].map((value) => ({ value }));
  assert.equal(pickCard(hours, 3, 'nearest').value, '4h');
  assert.equal(pickCard([{ value: '?' }, { value: 'cof' }], 3, 'nearest'), null);
});

const S = (o) => sanitizeSettings(Object.assign({ enabled: true }, o));

test('decide: copy mode', () => {
  const ps = [
    { name: 'Alice', vote: '3', isSelf: true },
    { name: 'Bob', vote: '8', isSelf: false, updatedAt: 1 },
    { name: 'Carol', vote: null, isSelf: false },
  ];
  assert.equal(decide({ settings: S({ trackName: '  bob ' }), participants: ps, cards: DECK }).target, '8');
  assert.equal(decide({ settings: S({ trackName: 'Carol' }), participants: ps, cards: DECK }).target, null);
  assert.match(decide({ settings: S({ trackName: 'Carol' }), participants: ps, cards: DECK }).info, /ещё не проголосовал/);
  assert.match(decide({ settings: S({ trackName: 'Dave' }), participants: ps, cards: DECK }).problem, /не найден/);
  assert.match(decide({ settings: S({ trackName: 'alice' }), participants: ps, cards: DECK }).problem, /собственный/);
  assert.match(decide({ settings: S({ trackName: '' }), participants: ps, cards: DECK }).problem, /Укажите/);

  const cof = [{ name: 'Bob', vote: 'cof', isSelf: false }];
  assert.equal(decide({ settings: S({ trackName: 'Bob' }), participants: cof, cards: DECK }).target, 'cof');

  const missing = [{ name: 'Bob', vote: '7', isSelf: false }];
  assert.match(decide({ settings: S({ trackName: 'Bob' }), participants: missing, cards: DECK }).problem, /нет в вашей колоде/);

  // Same nickname twice: the most recent voter wins.
  const dup = [
    { name: 'Bob', vote: '2', isSelf: false, updatedAt: 10 },
    { name: 'Bob', vote: '13', isSelf: false, updatedAt: 20 },
    { name: 'Bob', vote: null, isSelf: false, updatedAt: 30 },
  ];
  const d = decide({ settings: S({ trackName: 'Bob' }), participants: dup, cards: DECK });
  assert.equal(d.target, '13');
  assert.match(d.info, /3 участника/);

  // Values with stray spaces (custom decks like "1, 2, 3").
  const spaced = [{ name: 'Bob', vote: ' 2', isSelf: false }];
  assert.equal(decide({ settings: S({ trackName: 'Bob' }), participants: spaced, cards: [{ value: '1' }, { value: ' 2' }] }).target, ' 2');
});

test('decide: average mode', () => {
  const ps = [
    { name: 'Me', vote: '100', isSelf: true },
    { name: 'B', vote: '5', isSelf: false },
    { name: 'C', vote: '8', isSelf: false },
    { name: 'D', vote: '?', isSelf: false },
    { name: 'E', vote: 'cof', isSelf: false },
    { name: 'F', vote: null, isSelf: false },
  ];
  const d = decide({ settings: S({ mode: 'average' }), participants: ps, cards: DECK });
  assert.equal(d.avg, 6.5, 'own vote, "?", coffee and empty votes are excluded');
  assert.equal(d.count, 2);
  assert.equal(d.target, '8');
  assert.equal(decide({ settings: S({ mode: 'average', rounding: 'down' }), participants: ps, cards: DECK }).target, '5');
  const none = decide({ settings: S({ mode: 'average' }), participants: [{ name: 'D', vote: '?' }], cards: DECK });
  assert.equal(none.target, null);
});

test('sanitizeSettings', () => {
  assert.deepEqual(sanitizeSettings(null), { ...Core.DEFAULT_SETTINGS });
  const s = sanitizeSettings({ enabled: 'yes', mode: 'x', rounding: 'up', timing: 'reveal', delayMin: '5', delayMax: '2', trackName: 7 });
  assert.equal(s.enabled, false);
  assert.equal(s.mode, 'copy');
  assert.equal(s.rounding, 'up');
  assert.equal(s.timing, 'reveal');
  assert.equal(s.delayMin, 2);
  assert.equal(s.delayMax, 5);
  assert.equal(s.trackName, '7');
  assert.equal(sanitizeSettings({ delayMin: -3, delayMax: 'abc' }).delayMin, 0);
  assert.equal(sanitizeSettings({ delayMax: 1e9 }).delayMax, 120);
});
