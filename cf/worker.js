import './timers.js';
import { DurableObject } from 'cloudflare:workers';

const state = (globalThis.__CF = globalThis.__CF || {});

try {
  globalThis.addEventListener('unhandledrejection', e => {
    console.error('unhandledrejection:', (e.reason && e.reason.stack) || e.reason);
    if (e.preventDefault) e.preventDefault();
  });
  globalThis.addEventListener('error', e => {
    console.error('uncaught:', (e.error && e.error.stack) || e.message);
    try { state.logErr && state.logErr('uncaught', e.error || e.message); } catch {}
    if (e.preventDefault) e.preventDefault();
  });
} catch {}

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
    const lastPut = {};
    state.persist = (k, v) => {
      const now = Date.now();
      if (now - (lastPut[k] || 0) < 600000) return;
      lastPut[k] = now;
      try { Promise.resolve(this.ctx.storage.put(k, v)).catch(() => {}); } catch {}
    };
    // Ойын күйін сақтау үшін (сервер қайта іске қосылса ойын жалғасады)
    state.putNow = (k, v) => this.ctx.storage.put(k, v);
    state.getNow = (k) => this.ctx.storage.get(k);
    state.delNow = (k) => this.ctx.storage.delete(k);
    state.listNow = (prefix) => this.ctx.storage.list({ prefix });
    // Іске қосылу кешіксе де, кейін аяқталғанда DO қалпына келуі үшін ready ешқашан «қате» болмайды.
    // Күту уақыты әр сұраныста бөлек шектеледі.
    this.bootAt = Date.now();
    this.isReady = false;

    // Диагностика: DO қанша рет және қашан қайта іске қосылғанын, соңғы қателерді сақтаймыз
    const errs = [];
    state.logErr = (kind, e) => {
      errs.push({ at: new Date().toISOString(), kind, msg: String((e && e.stack) || e).slice(0, 600) });
      if (errs.length > 20) errs.shift();
    };
    this.errs = errs;
    // Іске қосылу уақытын 1 минуттан кейін ғана, бір рет жазамыз. Конструкторда жазу жоқ:
    // лимит бітсе DO мүлде көтерілмей қалады.
    setTimeout(async () => {
      try {
        const boots = (await this.ctx.storage.get('boots')) || [];
        boots.push(new Date(this.bootAt).toISOString());
        while (boots.length > 40) boots.shift();
        await this.ctx.storage.put('boots', boots);
      } catch {}
    }, 60000);
    // server.js модулі бір isolate ішінде қайта орындалмайды: DO объектісі қайта жасалса,
    // listen() қайта шақырылмайды. Сондықтан сервер бұрын іске қосылған болса, бірден «дайын» деп аламыз.
    this.ready = state.isListening
      ? Promise.resolve()
      : new Promise((resolve) => { state.listening = resolve; });
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

  // Кез келген қате 1101 экранының орнына оқылатын мәтінмен қайтады
  async fetch(request) {
    try {
      return await this.fetchInner(request);
    } catch (e) {
      const msg = String((e && e.stack) || e);
      console.error('fetch error:', msg);
      try { state.logErr && state.logErr('fetch', e); } catch {}
      return new Response('ERROR\n' + msg, { status: 500, headers: { 'content-type': 'text/plain; charset=utf-8' } });
    }
  }

  async fetchInner(request) {
    const url = new URL(request.url);
    if (url.pathname === '/_debug') {
      // Лимит бітсе, сақтау қатесі /_debug-ты құлатпай, мәтін ретінде көрсетілсін
      const safeGet = async (k) => {
        try { return await this.ctx.storage.get(k); }
        catch (e) { return 'STORAGE ERROR: ' + String((e && e.message) || e); }
      };
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
        boots: (await safeGet('boots')) || [],
        errs: this.errs,
        closes: state.closeLog || [],
        lastIn: state.lastIn || (await safeGet('lastIn')) || [],
        lastOut: state.lastOut || (await safeGet('lastOut')) || []
      });
    }
    try {
      await this.waitReady(25000);
    } catch (e) {
      console.error('503 starting:', e && e.message, 'upMs', Date.now() - this.bootAt);
      return new Response('starting: ' + (e && e.message), { status: 503 });
    }

    if (url.pathname === '/ws') {
      if (request.headers.get('Upgrade') !== 'websocket') return new Response('expected websocket', { status: 426 });
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      try { state.wss.accept(server); } catch (e) {
        console.error('ws accept error:', e && e.message);
        try { server.close(1011, 'accept failed'); } catch {}
        return new Response('ws error', { status: 500 });
      }
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
      const r = await env.ASSETS.fetch(new Request(new URL('/app.js', url)));
      if (!r.ok) return new Response('app.js unavailable', { status: 502, headers: { 'cache-control': 'no-store' } });
      const original = await r.text();
      const text = original.replace(/(['"`])shashka-mini-app-tp6r\.onrender\.com\1/g, 'location.host');
      if (url.pathname === '/_appcheck') {
        const i = text.indexOf('WS_HOST');
        return Response.json({ status: r.status, originalHasRender: original.includes('onrender'), afterHasRender: text.includes('onrender'), length: original.length, snippet: text.slice(i, i + 260) });
      }
      return new Response(text, { status: r.status, headers: { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' } });
    }
    try {
      const stub = env.HUB.get(env.HUB.idFromName('main'));
      return await stub.fetch(request);
    } catch (e) {
      return new Response('ERROR (DO)\n' + String((e && e.stack) || e), { status: 500, headers: { 'content-type': 'text/plain; charset=utf-8' } });
    }
  }
};
