// Pure logic shared by the content script and the unit tests: a mirror of the
// Firebase data the page receives, and the decision of which card to play.
(function (root) {
  'use strict';

  const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  const isObj = (v) => v !== null && typeof v === 'object';

  const normPath = (p) => String(p == null ? '' : p).replace(/^\/+|\/+$/g, '');
  const splitPath = (p) => {
    const n = normPath(p);
    return n ? n.split('/') : [];
  };

  // Firebase semantics: empty objects are null, ".priority" is metadata,
  // {".value": x} wraps a primitive.
  function normalize(v) {
    if (v === null || v === undefined) return null;
    if (!isObj(v)) return v;
    if (!Array.isArray(v) && hasOwn(v, '.value')) return normalize(v['.value']);
    const out = Object.create(null);
    let n = 0;
    for (const [k, x] of Object.entries(v)) {
      if (k === '.priority') continue;
      const nx = normalize(x);
      if (nx !== null) {
        out[k] = nx;
        n++;
      }
    }
    return n ? out : null;
  }

  // Tracks the data tree and which paths are currently in sync with the
  // server: a listen counts as synced once the server acknowledged it on a
  // socket we saw, and stops counting when that socket closes or the page
  // unlistens. Only synced data is trusted.
  class Mirror {
    constructor() {
      this.tree = Object.create(null);
      this.listens = new Map(); // `${sid}|${path}` -> { sid, path, synced }
      this.pending = new Map(); // `${sid}|${r}` -> listen key
      this.uid = null;
      this.sawSocket = false;
      this.version = 0;
    }

    handle(ev) {
      if (!isObj(ev)) return;
      const sid = ev.sid;
      switch (ev.k) {
        case 'created':
          this.sawSocket = true;
          break;
        case 'close':
          for (const [key, l] of this.listens) if (l.sid === sid) this.listens.delete(key);
          for (const key of [...this.pending.keys()]) if (key.startsWith(sid + '|')) this.pending.delete(key);
          break;
        case 'uid':
          if (typeof ev.uid === 'string' && ev.uid) this.uid = ev.uid;
          break;
        case 'listen':
          if (!ev.hasQuery) {
            const key = sid + '|' + normPath(ev.p);
            this.listens.set(key, { sid, path: normPath(ev.p), synced: false });
            if (ev.r != null) this.pending.set(sid + '|' + ev.r, key);
          }
          break;
        case 'unlisten':
        case 'revoked':
          if (!ev.hasQuery) this.listens.delete(sid + '|' + normPath(ev.p));
          break;
        case 'res': {
          const pk = sid + '|' + ev.r;
          if (!this.pending.has(pk)) break;
          const key = this.pending.get(pk);
          this.pending.delete(pk);
          const l = this.listens.get(key);
          if (!l) break;
          if (ev.s === 'ok') l.synced = true;
          else this.listens.delete(key);
          break;
        }
        case 'push':
          // Tagged pushes belong to filtered queries and are partial views.
          if (ev.t == null) this.apply(ev.p, ev.d, ev.a === 'm');
          break;
        default:
          return;
      }
      this.version++;
    }

    apply(path, data, merge) {
      const segs = splitPath(path);
      if (merge) {
        if (!isObj(data)) return;
        for (const [rel, v] of Object.entries(data)) this.setAt(segs.concat(splitPath(rel)), v);
      } else {
        this.setAt(segs, data);
      }
    }

    setAt(segs, raw) {
      const value = normalize(raw);
      if (!segs.length) {
        this.tree = isObj(value) ? value : Object.create(null);
        return;
      }
      let node = this.tree;
      const trail = [];
      for (let i = 0; i < segs.length - 1; i++) {
        const k = segs[i];
        if (!hasOwn(node, k) || !isObj(node[k])) {
          if (value === null) return;
          node[k] = Object.create(null);
        }
        trail.push([node, k]);
        node = node[k];
      }
      const last = segs[segs.length - 1];
      if (value === null) {
        delete node[last];
        for (let i = trail.length - 1; i >= 0; i--) {
          const [parent, k] = trail[i];
          if (Object.keys(parent[k]).length) break;
          delete parent[k];
        }
      } else {
        node[last] = value;
      }
    }

    get(path) {
      let n = this.tree;
      for (const s of splitPath(path)) {
        if (!isObj(n) || !hasOwn(n, s)) return null;
        n = n[s];
      }
      return n;
    }

    isSynced(path) {
      const p = normPath(path);
      for (const l of this.listens.values()) {
        if (!l.synced) continue;
        if (l.path === p || l.path === '' || p.startsWith(l.path + '/')) return true;
      }
      return false;
    }

    // Rooms whose estimates the page is currently listening to.
    listenedRooms() {
      const rooms = new Set();
      for (const l of this.listens.values()) {
        const m = /^scrumPoker\/estimates\/([^/]+)$/.exec(l.path);
        if (m) rooms.add(m[1]);
      }
      return [...rooms];
    }

    room(roomId) {
      const estPath = 'scrumPoker/estimates/' + roomId;
      const showPath = 'scrumPoker/showEstimates/' + roomId;
      const est = this.get(estPath);
      const participants = [];
      if (isObj(est)) {
        for (const [uid, v] of Object.entries(est)) {
          if (!isObj(v)) continue;
          participants.push({
            uid,
            name: typeof v.displayName === 'string' ? v.displayName : String(v.displayName == null ? '' : v.displayName),
            vote: voteOf(v.storyPoints),
            updatedAt: typeof v.updatedAt === 'number' ? v.updatedAt : 0,
          });
        }
      }
      const show = this.get(showPath);
      return {
        synced: this.isSynced(estPath),
        revealSynced: this.isSynced(showPath),
        participants,
        revealed: isObj(show) ? !!show.showEstimates : false,
      };
    }
  }

  // The site treats null/undefined/"" as "no estimate".
  function voteOf(v) {
    if (v === null || v === undefined) return null;
    const s = String(v);
    return s === '' ? null : s;
  }

  const sameValue = (a, b) => a != null && b != null && String(a).trim() === String(b).trim();

  const normName = (s) =>
    String(s == null ? '' : s)
      .normalize('NFKC')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();

  // Same parsing the site uses for its average ("?" and "cof" are ignored).
  const numOf = (v) => {
    if (v == null) return NaN;
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : NaN;
  };

  const EPS = 1e-9;

  // rounding: 'nearest' (ties go up), 'up', 'down'.
  function pickCard(cards, avg, rounding) {
    const numeric = cards
      .map((c, i) => ({ c, i, n: numOf(c.value) }))
      .filter((x) => Number.isFinite(x.n))
      .sort((a, b) => a.n - b.n || a.i - b.i);
    if (!numeric.length || !Number.isFinite(avg)) return null;
    if (rounding === 'up') {
      const hit = numeric.find((x) => x.n >= avg - EPS);
      return (hit || numeric[numeric.length - 1]).c;
    }
    if (rounding === 'down') {
      let hit = null;
      for (const x of numeric) if (x.n <= avg + EPS) hit = x;
      return (hit || numeric[0]).c;
    }
    let best = numeric[0];
    for (const x of numeric) {
      const d = Math.abs(x.n - avg);
      const bd = Math.abs(best.n - avg);
      if (d < bd - EPS || (Math.abs(d - bd) <= EPS && x.n > best.n)) best = x;
    }
    return best.c;
  }

  const findCard = (cards, value) => cards.find((c) => sameValue(c.value, value)) || null;

  const fmt = (n) => String(Math.round(n * 100) / 100);

  // participants: [{ name, vote, isSelf, updatedAt? }]
  // Returns { target, info, problem, ... }; target is the card value to play or null.
  function decide({ settings, participants, cards }) {
    const others = participants.filter((p) => !p.isSelf);

    if (settings.mode === 'average') {
      const nums = others.map((p) => numOf(p.vote)).filter(Number.isFinite);
      if (!nums.length) return { target: null, info: 'Пока нет числовых голосов других участников' };
      const avg = nums.reduce((a, b) => a + b, 0) / nums.length;
      const card = pickCard(cards, avg, settings.rounding);
      if (!card) return { target: null, problem: 'В колоде нет числовых карт', avg };
      return {
        target: card.value,
        avg,
        count: nums.length,
        info: `Среднее ${fmt(avg)} по ${nums.length} голос(ам) → карта ${card.value}`,
      };
    }

    const want = normName(settings.trackName);
    if (!want) return { target: null, problem: 'Укажите ник участника' };
    const matches = others.filter((p) => normName(p.name) === want);
    if (!matches.length) {
      if (participants.some((p) => p.isSelf && normName(p.name) === want)) {
        return { target: null, problem: 'Это ваш собственный ник' };
      }
      return { target: null, problem: `Участник «${settings.trackName.trim()}» не найден в комнате` };
    }
    const voted = matches.filter((p) => p.vote != null);
    const pool = (voted.length ? voted : matches).slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    const chosen = pool[0];
    const dup = matches.length > 1 ? ` (в комнате ${matches.length} участника с таким ником, взят последний проголосовавший)` : '';
    if (chosen.vote == null) return { target: null, info: `${chosen.name} ещё не проголосовал(а)${dup}` };
    const card = findCard(cards, chosen.vote);
    if (!card) return { target: null, problem: `Карты «${chosen.vote}» нет в вашей колоде${dup}` };
    return { target: card.value, info: `${chosen.name} → ${card.value}${dup}`, trackedName: chosen.name };
  }

  const DEFAULT_SETTINGS = Object.freeze({
    enabled: false,
    mode: 'copy', // 'copy' | 'average'
    trackName: '',
    rounding: 'nearest', // 'nearest' | 'up' | 'down'
    timing: 'immediate', // 'immediate' | 'reveal'
    delayMin: 1,
    delayMax: 3,
  });

  function sanitizeSettings(s) {
    const o = Object.assign({}, DEFAULT_SETTINGS, isObj(s) ? s : {});
    const clampDelay = (v) => {
      const n = Number(v);
      return Number.isFinite(n) && n > 0 ? Math.min(n, 120) : 0;
    };
    let a = clampDelay(o.delayMin);
    let b = clampDelay(o.delayMax);
    if (b < a) [a, b] = [b, a];
    return {
      enabled: o.enabled === true,
      mode: o.mode === 'average' ? 'average' : 'copy',
      trackName: String(o.trackName == null ? '' : o.trackName).slice(0, 200),
      rounding: o.rounding === 'up' || o.rounding === 'down' ? o.rounding : 'nearest',
      timing: o.timing === 'reveal' ? 'reveal' : 'immediate',
      delayMin: a,
      delayMax: b,
    };
  }

  const api = {
    Mirror,
    normalize,
    normPath,
    splitPath,
    voteOf,
    sameValue,
    normName,
    numOf,
    pickCard,
    findCard,
    decide,
    DEFAULT_SETTINGS,
    sanitizeSettings,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SPMCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
