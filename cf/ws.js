// "ws" кітапханасының қолданылатын бөлігін Cloudflare WebSocketPair үстінен қайталайды.
const state = (globalThis.__CF = globalThis.__CF || {});
const MAX_PAYLOAD = 16384;   // rtc сигналы (SDP) 8000 символға дейін өтеді, сондықтан 4096 тым аз
const IDLE_MS = 150000;      // осыдан ұзақ уақыт ешқандай хабарлама келмесе, қосылым «өлі» деп саналады

class Socket {
  constructor(sock) {
    this.sock = sock;
    this.readyState = 1;
    this.isAlive = true;
    this.lastMsg = Date.now();
    this.h = {};
  }
  on(ev, fn) { (this.h[ev] = this.h[ev] || []).push(fn); return this; }
  emit(ev, ...a) { (this.h[ev] || []).slice().forEach(fn => { try { fn(...a); } catch (e) { console.error('ws handler error:', e && e.message); } }); }
  send(data) {
    if (this.readyState !== 1) return;
    try { (state.lastOut = (state.lastOut || []).slice(-3)).push(String(data).slice(0, 100)); state.persist && state.persist('lastOut', state.lastOut); } catch {}
    try { this.sock.send(data); } catch {}
  }
  close() { if (this.readyState === 3) return; this.readyState = 2; try { this.sock.close(1000, 'bye'); } catch {} }
  terminate() { this.close(); }
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
    const done = () => {
      if (ws.readyState === 3) return;
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
    sock.addEventListener('close', done);
    sock.addEventListener('error', done);
    if (this.listeners.connection) this.listeners.connection(ws);
  }
}

module.exports = { WebSocketServer };
