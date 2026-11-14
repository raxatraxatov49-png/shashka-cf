// "ws" кітапханасының қолданылатын бөлігін Cloudflare WebSocketPair үстінен қайталайды.
const state = (globalThis.__CF = globalThis.__CF || {});
const MAX_PAYLOAD = 4096;

class Socket {
  constructor(sock) {
    this.sock = sock;
    this.readyState = 1;
    this.isAlive = true;
    this.h = {};
  }
  on(ev, fn) { (this.h[ev] = this.h[ev] || []).push(fn); return this; }
  emit(ev, ...a) { (this.h[ev] || []).slice().forEach(fn => { try { fn(...a); } catch (e) { console.error('ws handler error:', e && e.message); } }); }
  send(data) { if (this.readyState !== 1) return; try { this.sock.send(data); } catch {} }
  close() { if (this.readyState === 3) return; this.readyState = 2; try { this.sock.close(1000, 'bye'); } catch {} }
  terminate() { this.close(); }
  // Байланыстың тірі екенін Cloudflare өзі қадағалайды, сондықтан pong-ты бірден қайтарамыз
  ping() { this.emit('pong'); }
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
      ws.emit('message', d);
    });
    sock.addEventListener('close', done);
    sock.addEventListener('error', done);
    if (this.listeners.connection) this.listeners.connection(ws);
  }
}

module.exports = { WebSocketServer };
