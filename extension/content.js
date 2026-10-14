// Content script (isolated world). Keeps a mirror of the room data coming from
// page-hook.js, decides which card to play and clicks it like a user would.
(() => {
  'use strict';

  const { Mirror, decide, findCard, sameValue, normName, sanitizeSettings } = globalThis.SPMCore;

  const EVT_DATA = '__spm:data';
  const EVT_READY = '__spm:ready';
  const EVT_HELLO = '__spm:hello';

  const SETTLE_MS = 700; // min wait after the target changes (absorbs bursts like "Delete Estimates")
  const VERIFY_MS = 2500; // how long to wait for our vote to show up before retrying
  const MAX_ATTEMPTS = 3;
  const BLOCKED_RETRY_MS = 2000; // retry interval while the page swallows clicks

  const mirror = new Mirror();
  let settings = sanitizeSettings(null);
  let rememberedSelfName = null;

  // Engine state.
  let lastKey; // room + target last seen; a change marks the vote as "dirty"
  let dirty = true;
  let attempts = 0;
  let timer = null;
  let cooldownUntil = 0;
  let cooldownTimer = null;
  let lastAction = null;
  let lastSnap = null;
  let lastDecision = null;
  let evalQueued = false;

  const alive = () => {
    try {
      return !!(chrome.runtime && chrome.runtime.id);
    } catch (_) {
      return false;
    }
  };

  // ---------- page bridge ----------

  document.addEventListener(EVT_DATA, (e) => {
    if (typeof e.detail !== 'string') return;
    let ev;
    try {
      ev = JSON.parse(e.detail);
    } catch (_) {
      return;
    }
    mirror.handle(ev);
    scheduleEvaluate();
  });
  const announceReady = () => document.dispatchEvent(new CustomEvent(EVT_READY));
  document.addEventListener(EVT_HELLO, announceReady);
  announceReady();

  // ---------- DOM ----------

  const currentRoomId = () => {
    const m = /\/room\/([^/?#]+)/.exec(location.pathname);
    if (!m) return null;
    try {
      return decodeURIComponent(m[1]);
    } catch (_) {
      return m[1];
    }
  };

  // The coffee card is rendered as a Material icon ligature.
  const valueFromNode = (node) => {
    const text = node.textContent.trim();
    if (node.querySelector('mat-icon')) return text === 'coffee' ? 'cof' : text;
    return text;
  };

  const readCards = () => {
    const host = document.querySelector('provide-estimate');
    if (!host) return [];
    const cards = [];
    for (const el of host.querySelectorAll('.flex-container > div')) {
      const middle = el.querySelector('.middle');
      if (!middle) continue;
      cards.push({ el, value: valueFromNode(middle), selected: el.classList.contains('selected') });
    }
    return cards;
  };

  // Fallback source: the results table. Values are in the DOM before the
  // reveal too (on the back side of the flip card).
  const readTable = () => {
    const table = [...document.querySelectorAll('table')].find((t) => t.querySelector('td.mat-column-displayName'));
    if (!table) return null;
    const rows = [];
    for (const tr of table.querySelectorAll('tbody tr')) {
      const nameCell = tr.querySelector('td.mat-column-displayName');
      const pointsCell = tr.querySelector('td.mat-column-storyPoints');
      if (!nameCell || !pointsCell) continue;
      // Direct text only: the cell may also hold a presence indicator.
      const name = [...nameCell.childNodes]
        .filter((n) => n.nodeType === Node.TEXT_NODE)
        .map((n) => n.textContent)
        .join('')
        .trim();
      const back = pointsCell.querySelector('.flip-card-back');
      const vote = back ? valueFromNode(back) : '';
      rows.push({
        name,
        vote: vote === '' ? null : vote,
        flipped: !!pointsCell.querySelector('.flip-card.flip-card-transform'),
      });
    }
    return { rows, revealed: rows.some((r) => r.flipped) };
  };

  // ---------- snapshot ----------

  const snapshot = () => {
    const roomId = currentRoomId();
    const cards = readCards();
    const selectedCard = cards.find((c) => c.selected);
    const snap = {
      roomId,
      cards,
      source: null,
      participants: [],
      revealed: false,
      selfUid: mirror.uid,
      selfName: null,
      myVote: selectedCard ? selectedCard.value : null,
    };
    if (!roomId) return snap;

    const room = mirror.room(roomId);
    if (room.synced) {
      snap.source = 'ws';
      snap.participants = room.participants.map((p) => Object.assign({}, p, { isSelf: !!mirror.uid && p.uid === mirror.uid }));
      const me = snap.participants.find((p) => p.isSelf);
      if (me) {
        snap.myVote = me.vote;
        snap.selfName = me.name;
        rememberSelfName(me.name);
      }
      if (room.revealSynced) snap.revealed = room.revealed;
      else {
        const t = readTable();
        snap.revealed = !!(t && t.revealed);
      }
      return snap;
    }

    const table = readTable();
    if (!table || !table.rows.length) return snap;
    snap.source = 'dom';
    snap.revealed = table.revealed;
    snap.participants = table.rows.map((r) => ({ name: r.name, vote: r.vote, isSelf: false, updatedAt: 0 }));
    markSelfInTable(snap);
    return snap;
  };

  // Without uids the own row is found by the remembered display name. For the
  // average mode, dropping any one row that holds the own vote gives the same
  // result, so that is used when the name is unknown.
  const markSelfInTable = (snap) => {
    const list = snap.participants;
    const name = normName(rememberedSelfName);
    let self = null;
    if (name) {
      const byName = list.filter((p) => normName(p.name) === name);
      self = byName.find((p) => (p.vote == null && snap.myVote == null) || sameValue(p.vote, snap.myVote)) || byName[0] || null;
    }
    if (!self && settings.mode === 'average' && snap.myVote != null) {
      self = list.find((p) => sameValue(p.vote, snap.myVote)) || null;
    }
    if (self) {
      self.isSelf = true;
      snap.selfName = self.name;
    }
  };

  const rememberSelfName = (name) => {
    if (!name || name === rememberedSelfName) return;
    rememberedSelfName = name;
    if (!alive()) return;
    try {
      chrome.storage.local.set({ selfName: name });
    } catch (_) {}
  };

  // ---------- engine ----------

  const stopTimer = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };

  const delayMs = () => {
    const s = settings.delayMin + Math.random() * (settings.delayMax - settings.delayMin);
    return Math.max(SETTLE_MS, Math.round(s * 1000));
  };

  const resetSync = () => {
    lastKey = undefined;
    dirty = true;
    attempts = 0;
    cooldownUntil = 0;
    stopTimer();
  };

  const scheduleEvaluate = () => {
    if (evalQueued) return;
    evalQueued = true;
    setTimeout(evaluate, 30);
  };

  const computeDecision = (snap) =>
    snap.roomId && snap.source ? decide({ settings, participants: snap.participants, cards: snap.cards }) : null;

  function evaluate() {
    evalQueued = false;
    const snap = snapshot();
    const decision = computeDecision(snap);
    lastSnap = snap;
    lastDecision = decision;

    if (!settings.enabled || !decision || !snap.cards.length) {
      stopTimer();
      return;
    }
    const target = decision.target;
    const key = snap.roomId + '\u0000' + (target == null ? '' : target);
    if (key !== lastKey) {
      lastKey = key;
      dirty = true;
      attempts = 0;
      stopTimer();
    }
    if (target == null) return;
    if (sameValue(snap.myVote, target)) {
      dirty = false;
      stopTimer();
      if (lastAction && lastAction.roomId === snap.roomId && sameValue(lastAction.value, target)) lastAction.confirmed = true;
      return;
    }
    // Not dirty means the user picked another card by hand after we synced.
    if (!dirty) return;
    if (settings.timing === 'reveal' && !snap.revealed) {
      stopTimer();
      return;
    }
    if (attempts >= MAX_ATTEMPTS) return;
    // Right after a click, give the vote time to come back before retrying it.
    if (Date.now() < cooldownUntil && lastAction && lastAction.roomId === snap.roomId && sameValue(lastAction.value, target)) return;
    if (!timer) timer = setTimeout(fire, delayMs());
  }

  function fire() {
    timer = null;
    if (!settings.enabled) return;
    const snap = snapshot();
    const decision = computeDecision(snap);
    if (!decision || decision.target == null) return scheduleEvaluate();
    const target = decision.target;
    if (snap.roomId + '\u0000' + target !== lastKey) return scheduleEvaluate();
    if (sameValue(snap.myVote, target)) {
      dirty = false;
      return;
    }
    if (!dirty || (settings.timing === 'reveal' && !snap.revealed)) return;
    const card = findCard(snap.cards, target);
    if (!card) return;

    const reached = press(card);
    // A blocked click (e.g. the cookie consent banner swallows every click on
    // the page while it is open) does not use up an attempt; retry later.
    if (reached) attempts++;
    lastAction = { value: target, at: Date.now(), roomId: snap.roomId, attempt: attempts, confirmed: false, blocked: !reached };
    const wait = reached ? VERIFY_MS : BLOCKED_RETRY_MS;
    cooldownUntil = Date.now() + wait;
    if (cooldownTimer) clearTimeout(cooldownTimer);
    cooldownTimer = setTimeout(() => {
      cooldownTimer = null;
      cooldownUntil = 0;
      evaluate();
    }, wait + 20);
  }

  // Clicks the card like a user would. Returns false when something on the
  // page stopped the click before it reached the card.
  function press(card) {
    const target = card.el.querySelector('button') || card.el;
    let reached = false;
    const mark = () => {
      reached = true;
    };
    target.addEventListener('click', mark, true);
    try {
      target.click();
    } finally {
      target.removeEventListener('click', mark, true);
    }
    return reached;
  }

  // ---------- settings ----------

  const applySettings = (raw) => {
    const next = sanitizeSettings(raw);
    const changed = JSON.stringify(next) !== JSON.stringify(settings);
    settings = next;
    if (changed) {
      resetSync();
      scheduleEvaluate();
    }
  };

  try {
    chrome.storage.local.get(['settings', 'selfName'], (res) => {
      if (chrome.runtime.lastError || !res) return;
      if (typeof res.selfName === 'string') rememberedSelfName = rememberedSelfName || res.selfName;
      applySettings(res.settings);
    });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes.settings) applySettings(changes.settings.newValue);
    });
  } catch (_) {}

  // ---------- popup API ----------

  const buildState = () => {
    const snap = lastSnap || snapshot();
    const tracked = normName(settings.trackName);
    const target = lastDecision ? lastDecision.target : null;
    const mismatch = target != null && !sameValue(snap.myVote, target);
    return {
      ok: true,
      roomId: snap.roomId,
      inRoom: snap.cards.length > 0,
      source: snap.source,
      firebaseSeen: mirror.sawSocket,
      selfName: snap.selfName,
      myVote: snap.myVote,
      revealed: snap.revealed,
      participants: snap.participants.map((p) => ({
        name: p.name,
        vote: p.vote,
        isSelf: !!p.isSelf,
        isTracked: settings.mode === 'copy' && !p.isSelf && !!tracked && normName(p.name) === tracked,
      })),
      cards: snap.cards.map((c) => c.value),
      decision: lastDecision ? { target: lastDecision.target, info: lastDecision.info || null, problem: lastDecision.problem || null } : null,
      settings,
      pending: !!timer || Date.now() < cooldownUntil,
      waitingReveal: settings.timing === 'reveal' && !snap.revealed,
      manualOverride: mismatch && !dirty,
      gaveUp: mismatch && dirty && attempts >= MAX_ATTEMPTS,
      blocked: mismatch && dirty && !!lastAction && lastAction.blocked && lastAction.roomId === snap.roomId && sameValue(lastAction.value, target),
      lastAction,
    };
  };

  try {
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (!msg || typeof msg.type !== 'string') return;
      if (msg.type === 'spm:resync') resetSync();
      else if (msg.type !== 'spm:getState') return;
      evaluate();
      sendResponse(buildState());
    });
  } catch (_) {}

  // ---------- DOM changes ----------

  const observer = new MutationObserver(() => {
    if (!alive()) {
      observer.disconnect();
      stopTimer();
      return;
    }
    scheduleEvaluate();
  });
  observer.observe(document, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['class'] });
})();
