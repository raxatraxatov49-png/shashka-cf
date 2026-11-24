// "ws" кітапханасының қолданылатын бөлігін Cloudflare WebSocketPair үстінен қайталайды.
const state = (globalThis.__CF = globalThis.__CF || {});
const MAX_PAYLOAD = 16384;   // rtc сигналы (SDP) 8000 символға дейін өтеді, сондықтан 4096 тым аз
const IDLE_MS = 150000;      // осыдан ұзақ уақыт ешқандай хабарлама келмесе, қосылым «өлі» деп саналады

// Диагностика: үзілістердің себебін (код, кім жапты, қанша уақыт ашық болды) жазып отырамыз
const closeLog = (state.closeLog = state.closeLog || []);
let closeSaveTimer = null;
function logClose(entry) {
  try {
    closeLog.push({ at: new Date().toISOString(), ...entry });
    if (closeLog.length > 60) closeLog.shift();
    if (!closeSaveTimer && state.putNow) {
      closeSaveTimer = setTimeout(() => {
        closeSaveTimer = null;
        try { Promise.resolve(state.putNow('closes', closeLog)).catch(() => {}); } catch {}
      }, 3000);
    }
  } catch {}
}

class Socket {
  constructor(sock) {
    this.sock = sock;
    this.readyState = 1;
    this.isAlive = true;
    this.lastMsg = Date.now();
    this.openedAt = Date.now();
    this.h = {};
  }
  on(ev, fn) { (this.h[ev] = this.h[ev] || []).push(fn); return this; }
  emit(ev, ...a) { (this.h[ev] || []).slice().forEach(fn => { try { fn(...a); } catch (e) { console.error('ws handler error [' + ev + ']:', (e && e.stack) || e); try { state.logErr && state.logErr('ws:' + ev, e); } catch {} } }); }
  send(data) {
    if (this.readyState !== 1) return;
    try { (state.lastOut = (state.lastOut || []).slice(-3)).push(String(data).slice(0, 100)); state.persist && state.persist('lastOut', state.lastOut); } catch {}
    try { this.sock.send(data); } catch {}
  }
  close() {
    if (this.readyState === 3) return;
    if (this.readyState === 1) logClose({ who: 'server-close', uid: this.user && this.user.id, ageS: Math.round((Date.now() - this.openedAt) / 1000) });
    this.readyState = 2;
    try { this.sock.close(1000, 'bye'); } catch {}
  }
  // Өлі қосылым үшін peer-дің close оқиғасын күтпей, ойын логикасына бірден хабарлаймыз (GRACE таймері іске қосылсын)
  terminate() {
    if (this.readyState === 3) return;
    logClose({ who: 'server-terminate', uid: this.user && this.user.id, ageS: Math.round((Date.now() - this.openedAt) / 1000), idleS: Math.round((Date.now() - this.lastMsg) / 1000) });
    this.readyState = 2;
    try { this.sock.close(1000, 'dead'); } catch {}
    if (this._done) this._done();
  }
  // Байланыстың тірі екенін Cloudflare өзі қадағалайды, сондықтан pong-ты бірден қайтарамыз
  ping() { if (Date.now() - this.lastMsg < IDLE_MS) this.emit('pong'); }
}

class WebSocketServer {
  constructor() {
    this.clients = new Set();
    this.listeners = {};
    state.wss = this;
  }
  on(ev, fn) { this.listeners[ev] = fn; return this; }
  accept(sock) {
    sock.accept();
    const ws = new Socket(sock);
    this.clients.add(ws);
    const done = (ev) => {
      if (ws.readyState === 3) return;
      if (ev && ev.type) {
        logClose({ who: ws.readyState === 2 ? 'ack-after-server' : 'peer-or-runtime', ev: ev.type, code: ev.code, reason: String(ev.reason || '').slice(0, 60), clean: ev.wasClean, uid: ws.user && ws.user.id, ageS: Math.round((Date.now() - ws.openedAt) / 1000), idleS: Math.round((Date.now() - ws.lastMsg) / 1000) });
      }
      ws.readyState = 3;
      this.clients.delete(ws);
      ws.emit('close');
    };
    sock.addEventListener('message', e => {
      const d = e.data;
      const size = typeof d === 'string' ? d.length : (d.byteLength || 0);
      if (size > MAX_PAYLOAD) { ws.close(); return; }
      ws.isAlive = true;
      ws.lastMsg = Date.now();
      try { (state.lastIn = (state.lastIn || []).slice(-3)).push(String(d).slice(0, 120)); state.persist && state.persist('lastIn', state.lastIn); } catch {}
      ws.emit('message', d);
    });
    ws._done = done;
    sock.addEventListener('close', done);
    sock.addEventListener('error', done);
    if (this.listeners.connection) this.listeners.connection(ws);
  }
}

module.exports = { WebSocketServer };
