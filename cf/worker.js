import './timers.js';
import { DurableObject } from 'cloudflare:workers';

const state = (globalThis.__CF = globalThis.__CF || {});

export class Hub extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    const vars = {};
    const names = new Set(Object.keys(env));
    ['DEV','SKIP_WEBHOOK','REDIS_PREFIX','WEBHOOK_URL','MINI_APP_URL','BOT_TOKEN','WEBHOOK_SECRET',
     'UPSTASH_REDIS_REST_URL','UPSTASH_REDIS_REST_TOKEN','ADMIN_ID','ADMIN_IDS','ADMINS'].forEach(n => names.add(n));
    for (const k of names) {
      const v = env[k];
      if (typeof v === 'string') vars[k] = v;
    }
    vars.CF_WORKER = '1';
    try { Object.assign(process.env, vars); } catch {}
    // process.env жазуды қабылдамаса, оны қарапайым объектпен алмастырамыз
    if (Object.keys(vars).some(k => process.env[k] !== vars[k])) {
      try {
        Object.defineProperty(process, 'env', { value: { ...process.env, ...vars }, writable: true, configurable: true });
      } catch (e) { console.error('process.env set failed:', e && e.message); }
    }
    state.persist = (k, v) => { try { this.ctx.storage.put(k, v); } catch {} };
    // Іске қосылу кешіксе де, кейін аяқталғанда DO қалпына келуі үшін ready ешқашан «қате» болмайды.
    // Күту уақыты әр сұраныста бөлек шектеледі.
    this.bootAt = Date.now();
    this.isReady = false;
    this.ready = new Promise((resolve) => { state.listening = resolve; });
    this.ready.then(() => { this.isReady = true; this.readyMs = Date.now() - this.bootAt; });
    // server.js ЖОҒАРЫДАҒЫ env орнатылғаннан кейін ғана жүктеледі
    this.boot = import('../server.js').catch(e => { console.error('boot error:', e && e.stack || e); throw e; });
  }

  async waitReady(ms) {
    await this.boot;
    let timer;
    try {
      await Promise.race([
        this.ready,
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('startup timeout')), ms); })
      ]);
    } finally { clearTimeout(timer); }
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/_debug') {
      let bootErr = null;
      try { await this.waitReady(10000); } catch (e) { bootErr = String(e && e.message); }
      return Response.json({
        isReady: this.isReady,
        readyMs: this.readyMs || null,
        upMs: Date.now() - this.bootAt,
        DEV: process.env.DEV ?? null,
        CF_WORKER: process.env.CF_WORKER ?? null,
        envKeys: Object.keys(process.env).filter(k => !/TOKEN|SECRET|REDIS/i.test(k)),
        bootErr,
        bootInfo: globalThis.__bootInfo || null,
        hasHandler: !!state.handler,
        clients: state.wss ? state.wss.clients.size : null,
        lastIn: state.lastIn || (await this.ctx.storage.get('lastIn')) || [],
        lastOut: state.lastOut || (await this.ctx.storage.get('lastOut')) || []
      });
    }
    try {
      await this.waitReady(25000);
    } catch (e) {
      return new Response('starting', { status: 503 });
    }

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
    if (url.pathname === '/health') {
      return Response.json({ ok: true, DEV: env.DEV || null, SKIP_WEBHOOK: env.SKIP_WEBHOOK || null, keys: Object.keys(env) });
    }
    if (url.pathname === '/app.js' || url.pathname === '/_appcheck') {
      // Клиент қатты кодталған Render хостына қосылады; оны осы Worker-дің өз хостына ауыстырамыз
      const r = await env.ASSETS.fetch(new Request(new URL('/app.js', url), { headers: request.headers }));
      const original = await r.text();
      const text = original.replace(/(['"`])shashka-mini-app-tp6r\.onrender\.com\1/g, 'location.host');
      if (url.pathname === '/_appcheck') {
        const i = text.indexOf('WS_HOST');
        return Response.json({ status: r.status, originalHasRender: original.includes('onrender'), afterHasRender: text.includes('onrender'), length: original.length, snippet: text.slice(i, i + 260) });
      }
      return new Response(text, { status: r.status, headers: { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' } });
    }
    const stub = env.HUB.get(env.HUB.idFromName('main'));
    return stub.fetch(request);
  }
};
