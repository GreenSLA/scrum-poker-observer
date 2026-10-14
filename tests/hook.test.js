// Runs page-hook.js against a fake browser to check frame reassembly and filtering.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const HOOK = fs.readFileSync(path.join(__dirname, '..', 'extension', 'page-hook.js'), 'utf8');
const FB = 'wss://s-gke-usc1-nssi2-13.firebaseio.com/.ws?v=5&ns=scrumpoker-online';

function load({ readyFirst = true } = {}) {
  const listeners = {};
  const document = {
    addEventListener: (t, f) => (listeners[t] = listeners[t] || []).push(f),
    dispatchEvent: (ev) => {
      for (const f of listeners[ev.type] || []) f(ev);
      return true;
    },
  };
  class CustomEvent {
    constructor(type, init) {
      this.type = type;
      this.detail = init && init.detail;
    }
  }
  class FakeWS {
    constructor(url) {
      this.url = url;
      this.handlers = {};
      this.wire = [];
    }
    addEventListener(t, f) {
      (this.handlers[t] = this.handlers[t] || []).push(f);
    }
    send(d) {
      this.wire.push(d);
    }
    close() {}
    fire(t, ev) {
      for (const f of this.handlers[t] || []) f(ev);
    }
    recv(data) {
      this.fire('message', { data });
    }
  }
  const window = { WebSocket: FakeWS };
  const ctx = { window, document, CustomEvent, URL, location: { href: 'https://www.scrumpoker-online.org/en/room/1/scrum-poker' } };
  vm.createContext(ctx);
  const events = [];
  document.addEventListener('__spm:data', (e) => events.push(JSON.parse(e.detail)));
  if (readyFirst) {
    vm.runInContext(HOOK, ctx);
    document.dispatchEvent(new CustomEvent('__spm:ready'));
  } else {
    vm.runInContext(HOOK, ctx);
  }
  const ready = () => document.dispatchEvent(new CustomEvent('__spm:ready'));
  return { window, events, ready, FakeWS };
}

const kinds = (events) => events.map((e) => e.k);

test('only Firebase sockets are tapped and the class stays a WebSocket', () => {
  const { window, events, FakeWS } = load();
  const other = new window.WebSocket('wss://example.com/socket');
  assert.ok(other instanceof FakeWS);
  assert.equal(window.WebSocket.name, 'WebSocket');
  other.recv('{"t":"d","d":{"a":"d","b":{"p":"scrumPoker/estimates/1","d":{}}}}');
  other.send('{"t":"d","d":{"r":1,"a":"q","b":{"p":"/scrumPoker/estimates/1","h":""}}}');
  assert.deepEqual(events, []);
  assert.deepEqual(other.wire, ['{"t":"d","d":{"r":1,"a":"q","b":{"p":"/scrumPoker/estimates/1","h":""}}}']);
});

test('incoming data, multi-frame messages and auth uid', () => {
  const { window, events } = load();
  const ws = new window.WebSocket(FB);
  ws.fire('open', {});
  ws.recv('{"t":"c","d":{"t":"h","d":{"ts":1,"v":"5","h":"x","s":"y"}}}');
  ws.recv(JSON.stringify({ t: 'd', d: { r: 2, b: { s: 'ok', d: { auth: { provider: 'anonymous', uid: 'U1', token: { user_id: 'U1' } }, expires: 1 } } } }));
  const big = JSON.stringify({ t: 'd', d: { a: 'd', b: { p: 'scrumPoker/estimates/1', d: { B: { displayName: 'Bob'.repeat(50), storyPoints: '5' } } } } });
  ws.recv('3');
  ws.recv(big.slice(0, 40));
  ws.recv(big.slice(40, 90));
  ws.recv(big.slice(90));
  ws.recv('{"t":"d","d":{"a":"m","b":{"p":"scrumPoker/estimates/1/B","d":{"storyPoints":null}}}}');
  ws.recv('{"t":"d","d":{"a":"d","b":{"p":"users/U1","d":{"email":"secret@example.com"}}}}');
  ws.recv('{"t":"d","d":{"a":"d","b":{"p":"pokerRooms/1","d":{"ownerUid":"secret@example.com"}}}}');
  ws.recv('{"t":"d","d":{"a":"d","b":{"p":"scrumPoker/estimates/1","d":{"Q":{}},"t":7}}}');

  assert.deepEqual(kinds(events), ['created', 'open', 'uid', 'res', 'push', 'push', 'push']);
  assert.equal(events[2].uid, 'U1');
  assert.equal(events[4].d.B.storyPoints, '5');
  assert.equal(events[4].d.B.displayName.length, 150);
  assert.deepEqual(events[5], { k: 'push', sid: events[0].sid, a: 'm', p: 'scrumPoker/estimates/1/B', d: { storyPoints: null }, t: null });
  assert.equal(events[6].t, 7);
  assert.ok(!JSON.stringify(events).includes('secret@example.com'), 'unrelated paths are not forwarded');
});

test('outgoing listens are forwarded, credentials and keep-alives are not', () => {
  const { window, events } = load();
  const ws = new window.WebSocket(FB);
  ws.send('{"t":"d","d":{"r":2,"a":"auth","b":{"cred":"SECRET.JWT.TOKEN"}}}');
  ws.send('0');
  ws.send('{"t":"d","d":{"r":3,"a":"q","b":{"p":"/scrumPoker/estimates/1","h":""}}}');
  const longListen = JSON.stringify({ t: 'd', d: { r: 4, a: 'q', b: { p: '/scrumPoker/showEstimates/1', h: 'x'.repeat(100) } } });
  ws.send('2');
  ws.send(longListen.slice(0, 50));
  ws.send(longListen.slice(50));
  ws.send('{"t":"d","d":{"r":5,"a":"n","b":{"p":"/scrumPoker/estimates/1"}}}');
  ws.send('{"t":"d","d":{"r":6,"a":"q","b":{"p":"/scrumPoker/estimates/1","q":{"ep":5},"t":1,"h":""}}}');
  ws.send('{"t":"d","d":{"r":7,"a":"m","b":{"p":"/scrumPoker/estimates/1/U1","d":{"storyPoints":"5"}}}}');

  assert.ok(!JSON.stringify(events).includes('SECRET'), 'auth credentials never leave the page world');
  const fwd = events.filter((e) => e.k !== 'created');
  assert.deepEqual(fwd, [
    { k: 'listen', sid: 1, r: 3, p: '/scrumPoker/estimates/1', hasQuery: false },
    { k: 'listen', sid: 1, r: 4, p: '/scrumPoker/showEstimates/1', hasQuery: false },
    { k: 'unlisten', sid: 1, r: 5, p: '/scrumPoker/estimates/1', hasQuery: false },
    { k: 'listen', sid: 1, r: 6, p: '/scrumPoker/estimates/1', hasQuery: true },
  ]);
  assert.equal(ws.wire.length, 9, 'every frame still reaches the real socket unchanged');
  assert.equal(ws.wire[0], '{"t":"d","d":{"r":2,"a":"auth","b":{"cred":"SECRET.JWT.TOKEN"}}}');
});

test('close is reported once and late frames are ignored', () => {
  const { window, events } = load();
  const ws = new window.WebSocket(FB);
  ws.close();
  ws.fire('close', {});
  ws.recv('{"t":"d","d":{"a":"d","b":{"p":"scrumPoker/estimates/1","d":null}}}');
  assert.deepEqual(kinds(events), ['created', 'close']);
  const ws2 = new window.WebSocket(FB);
  ws2.recv('{"t":"d","d":{"a":"d","b":{"p":"scrumPoker/estimates/1","d":null}}}');
  assert.equal(events.at(-1).sid, 2);
});

test('events are buffered until the content script is ready', () => {
  const { window, events, ready } = load({ readyFirst: false });
  const ws = new window.WebSocket(FB);
  ws.recv('{"t":"d","d":{"a":"d","b":{"p":"scrumPoker/estimates/1","d":null}}}');
  assert.deepEqual(events, []);
  ready();
  assert.deepEqual(kinds(events), ['created', 'push']);
  ready();
  assert.equal(events.length, 2, 'a second ready does not replay twice');
});
