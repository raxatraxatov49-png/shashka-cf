import './timers.js';
import { DurableObject } from 'cloudflare:workers';

const state = (globalThis.__CF = globalThis.__CF || {});

export class Hub extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    for (const [k, v] of Object.entries(env)) {
      if (typeof v === 'string') process.env[k] = v;
    }
    process.env.CF_WORKER = '1';
    this.ready = new Promise((resolve, reject) => {
      state.listening = resolve;
      setTimeout(() => reject(new Error('startup timeout')), 25000);
    });
    this.ready.catch(() => {});
    // server.js ЖОҒАРЫДАҒЫ env орнатылғаннан кейін ғана жүктеледі
    this.boot = import('../server.js').catch(e => { console.error('boot error:', e && e.stack || e); throw e; });
  }

  async fetch(request) {
    try {
      await this.boot;
      await this.ready;
    } catch (e) {
      return new Response('starting', { status: 503 });
    }
    const url = new URL(request.url);

    if (url.pathname === '/ws') {
      if (request.headers.get('Upgrade') !== 'websocket') return new Response('expected websocket', { status: 426 });
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      state.wss.accept(server);
      return new Response(null, { status: 101, webSocket: client });
    }

    const handler = state.handler;
    if (!handler) return new Response('no handler', { status: 500 });

    const body = request.method === 'GET' || request.method === 'HEAD' ? '' : await request.text();
    const headers = {};
    request.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });
    const req = {
      method: request.method,
      url: url.pathname + url.search,
      headers,
      async *[Symbol.asyncIterator]() { if (body) yield body; }
    };

    return new Promise(resolve => {
      let status = 200;
      const outHeaders = {};
      const res = {
        setHeader(k, v) { outHeaders[k] = v; },
        writeHead(s, h) { status = s; if (h) Object.assign(outHeaders, h); return res; },
        write() {},
        end(data) {
          const nullBody = status === 204 || status === 304 || request.method === 'HEAD';
          resolve(new Response(nullBody ? null : (data == null ? '' : data), { status, headers: outHeaders }));
        }
      };
      Promise.resolve(handler(req, res)).catch(e => {
        console.error('http handler error:', e && e.message);
        resolve(new Response('error', { status: 500 }));
      });
    });
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/health') return new Response('ok');
    const stub = env.HUB.get(env.HUB.idFromName('main'));
    return stub.fetch(request);
  }
};
