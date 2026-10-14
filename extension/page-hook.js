// Runs in the page's MAIN world at document_start, before any site script.
// Taps the Firebase Realtime Database WebSocket and forwards the relevant
// messages to the extension's content script. Frames are only read, never
// modified, and auth tokens are never forwarded.
(() => {
  'use strict';

  if (window.__spmHookInstalled) return;
  try {
    Object.defineProperty(window, '__spmHookInstalled', { value: true });
  } catch (_) {
    return;
  }

  const EVT_DATA = '__spm:data';
  const EVT_READY = '__spm:ready';
  const EVT_HELLO = '__spm:hello';
  const MAX_BUFFER = 20000;

  const NativeWebSocket = window.WebSocket;
  if (typeof NativeWebSocket !== 'function') return;

  // Messages are buffered until the content script says it is listening.
  let ready = false;
  const buffer = [];
  const dispatch = (s) => {
    try {
      document.dispatchEvent(new CustomEvent(EVT_DATA, { detail: s }));
    } catch (_) {}
  };
  const post = (obj) => {
    let s;
    try {
      s = JSON.stringify(obj);
    } catch (_) {
      return;
    }
    if (ready) {
      dispatch(s);
    } else {
      buffer.push(s);
      if (buffer.length > MAX_BUFFER) buffer.shift();
    }
  };
  document.addEventListener(EVT_READY, () => {
    if (ready) return;
    ready = true;
    for (const s of buffer.splice(0)) dispatch(s);
  });
  document.dispatchEvent(new CustomEvent(EVT_HELLO));

  const isFirebaseUrl = (url) => {
    try {
      const host = new URL(String(url), location.href).hostname;
      return /(^|\.)firebaseio\.com$/.test(host) || /(^|\.)firebasedatabase\.app$/.test(host);
    } catch (_) {
      return false;
    }
  };

  const isRelevantPath = (p) => {
    const first = String(p == null ? '' : p).replace(/^\/+/, '').split('/')[0];
    return first === '' || first === 'scrumPoker';
  };

  // Same reassembly rules as the SDK (WebSocketConnection.handleIncomingFrame):
  // a short numeric frame announces how many frames the next message spans.
  const makeIncomingAssembler = (onMessage) => {
    let frames = null;
    let total = 0;
    return (data) => {
      if (typeof data !== 'string') return;
      if (frames === null) {
        if (data.length <= 6 && !isNaN(Number(data))) {
          total = Number(data);
          frames = [];
          return;
        }
        total = 1;
        frames = [];
      }
      frames.push(data);
      if (frames.length === total) {
        const full = frames.join('');
        frames = null;
        onMessage(full);
      }
    };
  };

  // The SDK announces a split outgoing message with its segment count (>= 2);
  // a bare "0" is its keep-alive.
  const makeOutgoingAssembler = (onMessage) => {
    let frames = null;
    let total = 0;
    return (data) => {
      if (typeof data !== 'string') return;
      if (frames === null) {
        if (/^\d{1,6}$/.test(data)) {
          const n = Number(data);
          if (n >= 2) {
            total = n;
            frames = [];
          }
          return;
        }
        onMessage(data);
        return;
      }
      frames.push(data);
      if (frames.length === total) {
        const full = frames.join('');
        frames = null;
        onMessage(full);
      }
    };
  };

  const onIncoming = (sid, text) => {
    let msg;
    try {
      msg = JSON.parse(text);
    } catch (_) {
      return;
    }
    if (!msg || msg.t !== 'd' || !msg.d || typeof msg.d !== 'object') return;
    const d = msg.d;
    const b = d.b && typeof d.b === 'object' ? d.b : {};
    if ('r' in d) {
      const auth = b.d && typeof b.d === 'object' ? b.d.auth : null;
      if (auth && typeof auth === 'object') {
        const uid = auth.uid || auth.user_id || (auth.token && auth.token.user_id);
        if (typeof uid === 'string' && uid) post({ k: 'uid', sid, uid });
      }
      post({ k: 'res', sid, r: d.r, s: b.s });
      return;
    }
    if ('error' in d) return;
    if ((d.a === 'd' || d.a === 'm') && isRelevantPath(b.p)) {
      post({ k: 'push', sid, a: d.a, p: b.p, d: b.d === undefined ? null : b.d, t: b.t == null ? null : b.t });
    } else if (d.a === 'c' && isRelevantPath(b.p)) {
      post({ k: 'revoked', sid, p: b.p, hasQuery: b.q != null });
    }
  };

  const onOutgoing = (sid, text) => {
    let msg;
    try {
      msg = JSON.parse(text);
    } catch (_) {
      return;
    }
    if (!msg || msg.t !== 'd' || !msg.d || typeof msg.d !== 'object') return;
    const d = msg.d;
    const b = d.b && typeof d.b === 'object' ? d.b : {};
    if ((d.a === 'q' || d.a === 'n') && isRelevantPath(b.p)) {
      post({ k: d.a === 'q' ? 'listen' : 'unlisten', sid, r: d.r, p: b.p, hasQuery: b.q != null });
    }
  };

  const taps = new WeakMap();
  let nextSid = 1;

  const attach = (ws) => {
    const sid = nextSid++;
    const tap = { sid, closed: false, out: null };
    const inAsm = makeIncomingAssembler((t) => onIncoming(sid, t));
    const outAsm = makeOutgoingAssembler((t) => onOutgoing(sid, t));
    const markClosed = () => {
      if (tap.closed) return;
      tap.closed = true;
      post({ k: 'close', sid });
    };
    tap.out = (data) => {
      if (!tap.closed) outAsm(data);
    };
    tap.markClosed = markClosed;
    ws.addEventListener('open', () => post({ k: 'open', sid }));
    ws.addEventListener('close', markClosed);
    ws.addEventListener('message', (ev) => {
      if (tap.closed) return;
      try {
        inAsm(ev.data);
      } catch (_) {}
    });
    taps.set(ws, tap);
    post({ k: 'created', sid });
  };

  class WebSocket extends NativeWebSocket {
    constructor(...args) {
      super(...args);
      try {
        if (isFirebaseUrl(args[0])) attach(this);
      } catch (_) {}
    }

    send(data) {
      const result = super.send(data);
      const tap = taps.get(this);
      if (tap) {
        try {
          tap.out(data);
        } catch (_) {}
      }
      return result;
    }

    close(...args) {
      const tap = taps.get(this);
      if (tap) {
        try {
          tap.markClosed();
        } catch (_) {}
      }
      return super.close(...args);
    }
  }

  window.WebSocket = WebSocket;
})();
