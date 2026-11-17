'use strict';

/*
 * Олимпиадалық турнир (knockout).
 * server.js ішінен createTournament(deps) арқылы қосылады.
 * Бір уақытта тек бір белсенді турнир болады: reg (тіркелу) -> live (ойын) -> done.
 */

const READY_MS = 3 * 60 * 1000;   // әр ойынға «дайынмын» басуға берілетін уақыт
const TICK_MS = 5000;
const TZ_MIN = 300;                       // UTC+5 (Қазақстан), deps.tzOffsetMin арқылы өзгертіледі
const REMIND_MS = 5 * 60 * 1000;
const FREE_PRIZE = 1000;                  // тегін турнир: тек 1-орынға койн
const STARS_FEES = [5, 10, 25, 50];      // ақылы турнир: кіру ақысы (Stars)
const FALLBACK_TIERS = [15, 25, 50, 100];

const START_DM = {
  kk: n => `🏆 <b>${n}</b> турнирі басталды!\nОйыныңызды бастау үшін мини-appты ашыңыз.`,
  ru: n => `🏆 Турнир <b>${n}</b> начался!\nОткройте мини-приложение, чтобы начать свою игру.`,
  uz: n => `🏆 <b>${n}</b> turniri boshlandi!\nO‘yiningizni boshlash uchun mini-ilovani oching.`,
  kaa: n => `🏆 <b>${n}</b> турнири басланды!\nОйыныңызды баслаў ушын мини-appты ашың.`
};
const SOON_DM = {
  kk: n => `⏰ <b>${n}</b> турнирі <b>5 минуттан</b> кейін басталады.\nДайын болыңыз, мини-appты ашып күтіңіз!`,
  ru: n => `⏰ Турнир <b>${n}</b> начнётся через <b>5 минут</b>.\nБудьте готовы и откройте мини-приложение!`,
  uz: n => `⏰ <b>${n}</b> turniri <b>5 daqiqadan</b> keyin boshlanadi.\nTayyor bo‘ling, mini-ilovani oching!`,
  kaa: n => `⏰ <b>${n}</b> турнири <b>5 минуттан</b> кейин басланады.\nТаяр болың, мини-appты ашып күтиң!`
};
const START_BTN = { kk: '🏆 Турнирге өту', ru: '🏆 К турниру', uz: '🏆 Turnirga o‘tish', kaa: '🏆 Турнирге өтиў' };

function createTournament(deps) {
  const {
    users, games, profiles, shop, startGame, send, isOnline, isBusy,
    isBanned, publicName, saveData, telegramApi, editAdminMessage,
    adminActions, escapeHtml, getLang, miniAppUrl, ownerId
  } = deps;
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  let data = { seq: 0, v: 0, active: null, last: null };
  let pushTimer = null;

  /* ---------- Сақтау ---------- */

  function load(raw) {
    if (raw && typeof raw === 'object') {
      data = Object.assign({ seq: 0, v: 0, active: null, last: null }, raw);
    }
  }

  function save() {
    data.v = (data.v || 0) + 1;
    saveData(data);
    pushSoon();
  }

  const nameOf = id =>
    id ? publicName((profiles.get(String(id)) || {}).name, id) : '—';

  const act = () => data.active;

  /* ---------- Сетка ---------- */

  function shuffle(a) {
    a = a.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function mkMatch(a, b) {
    return { a: a || null, b: b || null, w: null, ra: false, rb: false, g: null, dl: 0 };
  }

  // 1-кезең: size = келесі 2 дәрежесі. Артық орындарға автоматты өту (bye).
  function buildFirstRound(ids) {
    const n = ids.length;
    let size = 2;
    while (size < n) size *= 2;

    const byes = size - n;
    const list = shuffle(ids);
    const round = [];

    for (let i = 0; i < byes; i++) round.push(mkMatch(list[i], null));
    for (let i = byes; i < n; i += 2) round.push(mkMatch(list[i], list[i + 1]));

    return round;
  }

  function openRound(t, round) {
    const now = Date.now();

    for (const m of round) {
      if (!m.a && !m.b) { m.w = '-'; continue; }          // екеуі де жоқ
      if (!m.a || !m.b) { m.w = m.a || m.b; continue; }   // bye
      m.dl = now + READY_MS;
    }
  }

  function roundDone(round) {
    return round.every(m => m.w);
  }

  function loserOf(m) {
    if (!m.w || m.w === '-' || !m.a || !m.b) return null;
    return m.w === m.a ? m.b : m.a;
  }

  function pay(id, coins) {
    if (!id || !coins) return;

    try {
      shop.addCoins(id, coins);
    } catch (e) {
      console.error('Турнир жүлдесі берілмеді:', id, e.message);
    }
  }

  function finishTournament(t) {
    const rounds = t.rounds;
    const last = rounds[rounds.length - 1];
    const final = last[0];
    const first = final.w && final.w !== '-' ? final.w : null;
    const second = first ? loserOf(final) : null;

    let third = [];

    if (rounds.length >= 2) {
      third = rounds[rounds.length - 2]
        .map(loserOf)
        .filter(Boolean);
    }

    t.status = 'done';
    t.endedAt = Date.now();
    t.result = { first, second, third };
    t.paid = {};

    if (!first) {
      t.gift = t.kind === 'stars' ? { status: 'none', pool: poolOf(t) } : undefined;
    } else if (t.kind === 'stars') {
      t.gift = { status: 'pending', pool: poolOf(t) };
    } else {
      pay(first, FREE_PRIZE);
      t.paid[first] = FREE_PRIZE;
    }

    data.last = t;
    data.active = null;

    if (first && t.kind === 'stars') {
      save();
      sendWinnerGift(t).catch(e => console.error('Подарок қатесі:', e.message));
    }
  }

  /* ---------- Stars: банк, подарок, қайтару ---------- */

  let giftCache = { at: 0, list: [] };

  async function loadGifts(force) {
    if (!force && giftCache.list.length && Date.now() - giftCache.at < 10 * 60 * 1000) {
      return giftCache.list;
    }

    try {
      const r = await telegramApi('getAvailableGifts', {});
      const list = ((r.result && r.result.gifts) || [])
        .filter(g => g && g.id && g.star_count > 0 && !g.is_premium && g.remaining_count !== 0)
        .sort((a, b) => a.star_count - b.star_count);

      if (list.length) giftCache = { at: Date.now(), list };
    } catch (e) {
      console.error('getAvailableGifts қатесі:', e.message);
    }

    return giftCache.list;
  }

  function poolOf(t) {
    return Object.values(t.pay || {}).reduce((s, p) => s + (p.a || 0), 0);
  }

  async function pickGift(pool) {
    const list = await loadGifts();
    let best = null;

    for (const g of list) {
      if (g.star_count <= pool && (!best || g.star_count > best.star_count)) best = g;
    }

    return best;
  }

  function tiers() {
    const set = [...new Set(giftCache.list.map(g => g.star_count))];
    return (set.length ? set : FALLBACK_TIERS).slice(0, 8);
  }

  async function sendWinnerGift(t) {
    const pool = poolOf(t);
    const winner = t.result.first;
    const g = await pickGift(pool);

    if (!g) {
      // Банк ең арзан подарокқа жетпейді: койн береміз
      pay(winner, FREE_PRIZE);
      t.paid[winner] = FREE_PRIZE;
      t.gift = { status: 'coins', pool };
      save();
      return;
    }

    try {
      await telegramApi('sendGift', {
        user_id: Number(winner),
        gift_id: g.id,
        text: ('🏆 ' + t.name).slice(0, 120)
      });

      t.gift = { status: 'sent', pool, stars: g.star_count, left: pool - g.star_count };
    } catch (e) {
      t.gift = { status: 'failed', pool, stars: g.star_count, giftId: g.id, err: String(e.message).slice(0, 120) };

      if (ownerId) {
        telegramApi('sendMessage', {
          chat_id: ownerId,
          text: `⚠️ Турнир подарогы жіберілмеді (${t.name}).\nЖеңімпаз: ${winner}\n${e.message}\n\nАдмин панель → Турнирлер → «Подарокты қайта жіберу».`
        }).catch(() => {});
      }
    }

    save();
  }

  async function refundOne(t, uid) {
    const p = t.pay && t.pay[uid];

    if (!p) return true;

    try {
      await telegramApi('refundStarPayment', {
        user_id: Number(uid),
        telegram_payment_charge_id: p.c
      });
      delete t.pay[uid];
      return true;
    } catch (e) {
      console.error('Stars қайтарылмады:', uid, e.message);
      return false;
    }
  }

  async function notifyPlayers(t, kind) {
    const table = kind === 'soon' ? SOON_DM : START_DM;

    for (const id of t.players.slice()) {
      const lang = (getLang && getLang(id)) || 'kk';
      const text = (table[lang] || table.kk)(escapeHtml(t.name));

      try {
        await telegramApi('sendMessage', {
          chat_id: id,
          parse_mode: 'HTML',
          text,
          reply_markup: {
            inline_keyboard: [[{
              text: START_BTN[lang] || START_BTN.kk,
              web_app: { url: miniAppUrl + '/?lang=' + lang }
            }]]
          }
        });
      } catch (e) {}

      await sleep(60);
    }
  }

  function startTournament(t) {
    t.status = 'live';
    t.startedAt = Date.now();
    t.rounds = [buildFirstRound(t.players)];
    openRound(t, t.rounds[0]);
    advance(t);
    save();

    notifyPlayers(t, 'start').catch(e => console.error('Хабарлама қатесі:', e.message));
  }

  async function autoCancel(t) {
    t.autoCancel = true;

    if (t.kind === 'stars') {
      for (const id of Object.keys(t.pay || {})) {
        await refundOne(t, id);
        await sleep(60);
      }
    }

    if (data.active === t) {
      data.active = null;
      save();
    }

    if (ownerId) {
      telegramApi('sendMessage', {
        chat_id: ownerId,
        text: `ℹ️ «${t.name}» турнирі ойыншы аз болғандықтан (кемінде 2) автоматты бас тартылды.` +
          (t.kind === 'stars' ? ' Төленген Stars қайтарылды.' : '')
      }).catch(() => {});
    }
  }

  // Басталу уақытын оқу: «22:30» (өтіп кетсе ертең) немесе «20.11 19:30»
  function parseStart(input) {
    const str = String(input || '').trim().replace(/\s+/g, ' ');
    const off = (typeof deps.tzOffsetMin === 'number' ? deps.tzOffsetMin : TZ_MIN) * 60000;
    const now = Date.now();
    const loc = new Date(now + off);
    let y = loc.getUTCFullYear();
    let mo = loc.getUTCMonth();
    let d = loc.getUTCDate();
    let hh;
    let mi;
    let dated = false;
    let m = /^(\d{1,2})[:.](\d{2})$/.exec(str);

    if (m) {
      hh = +m[1];
      mi = +m[2];
    } else if ((m = /^(\d{1,2})\.(\d{1,2})(?:\.(\d{4}))? (\d{1,2})[:.](\d{2})$/.exec(str))) {
      d = +m[1];
      mo = +m[2] - 1;
      if (m[3]) y = +m[3];
      hh = +m[4];
      mi = +m[5];
      dated = true;
    } else {
      return null;
    }

    if (hh > 23 || mi > 59 || mo < 0 || mo > 11 || d < 1 || d > 31) return null;

    let at = Date.UTC(y, mo, d, hh, mi) - off;

    if (!dated && at <= now + 60000) at += 86400000;

    if (at <= now + 60000) return null;

    const L = new Date(at + off);
    const p2 = n => String(n).padStart(2, '0');
    const today = new Date(now + off);
    const same = L.getUTCDate() === today.getUTCDate() && L.getUTCMonth() === today.getUTCMonth();

    return {
      at,
      text: p2(L.getUTCHours()) + ':' + p2(L.getUTCMinutes()) + (same ? '' : ' · ' + p2(L.getUTCDate()) + '.' + p2(L.getUTCMonth() + 1))
    };
  }

  // Төлем алдындағы тексеру (pre_checkout): қанша Stars төлеу керек
  function joinFee(userId, tid) {
    const t = act();
    userId = String(userId);

    if (!t || t.id !== tid || t.kind !== 'stars' || t.status !== 'reg') return 0;
    if (t.players.includes(userId) || t.players.length >= t.size) return 0;

    return t.fee;
  }

  // Төлем өткен соң ойыншыны тіркейміз
  function onPaid(userId, tid, chargeId, amount) {
    userId = String(userId);
    const t = act();

    if (!t || t.id !== tid || t.kind !== 'stars' || t.status !== 'reg' ||
        t.players.includes(userId) || t.players.length >= t.size || amount !== t.fee) {
      // Кеш қалып қалмау үшін қайтарамыз
      telegramApi('refundStarPayment', {
        user_id: Number(userId),
        telegram_payment_charge_id: chargeId
      }).catch(e => console.error('Қайтару қатесі:', e.message));
      return;
    }

    t.players.push(userId);
    t.pay = t.pay || {};
    t.pay[userId] = { c: chargeId, a: amount };
    save();

    const u = users.get(userId);
    if (u) send(u, full(userId));
  }

  function advance(t) {
    for (;;) {
      const round = t.rounds[t.rounds.length - 1];

      if (!roundDone(round)) return;

      if (round.length === 1) {
        finishTournament(t);
        return;
      }

      const winners = round.map(m => (m.w === '-' ? null : m.w));
      const next = [];

      for (let i = 0; i < winners.length; i += 2) {
        next.push(mkMatch(winners[i], winners[i + 1]));
      }

      t.rounds.push(next);
      openRound(t, next);
    }
  }

  /* ---------- Матч басқаруы ---------- */

  function curRound(t) {
    return t.rounds[t.rounds.length - 1];
  }

  function findMatch(t, id) {
    id = String(id);
    const round = curRound(t);

    for (let i = 0; i < round.length; i++) {
      const m = round[i];
      if (!m.w && (m.a === id || m.b === id)) return { m, i, r: t.rounds.length - 1 };
    }

    return null;
  }

  function setWinner(t, m, id) {
    m.w = id;
    m.g = null;
    advance(t);
    save();
  }

  function tryStart(t, m, r, i) {
    const ua = users.get(m.a);
    const ub = users.get(m.b);

    if (!isOnline(ua) || !isOnline(ub) || isBusy(ua) || isBusy(ub)) {
      return false;
    }

    const g = startGame(ua, ub);

    if (!g) return false;

    g.tour = { id: t.id, r, i };
    m.g = g.id;
    m.ra = false;
    m.rb = false;

    return true;
  }

  // Ойын аяқталғанда server.js finish() шақырады
  function onFinish(g, winner, reason) {
    const t = act();

    if (!t || !g.tour || g.tour.id !== t.id) return;

    const round = t.rounds[g.tour.r];
    const m = round && round[g.tour.i];

    if (!m || m.w || m.g !== g.id) return;

    m.g = null;

    const winnerId = winner === 'w' ? g.p.w : winner === 'b' ? g.p.b : null;

    if (winnerId) {
      setWinner(t, m, String(winnerId));
      return;
    }

    // Тең ойын: бірнеше секундтан соң қайта ойнатамыз
    m.ra = true;
    m.rb = true;
    m.dl = Date.now() + READY_MS;
    save();

    setTimeout(() => {
      const t2 = act();

      if (!t2 || t2.id !== t.id || m.w || m.g) return;

      if (!tryStart(t2, m, g.tour.r, g.tour.i)) {
        m.ra = false;
        m.rb = false;
      }

      save();
    }, 3000);
  }

  function tick() {
    const t = act();

    if (!t || t.autoCancel) return;

    const now = Date.now();

    // Тіркелу кезеңі: 5 минут қалғанда ескерту және уақыты келгенде автоматты бастау
    if (t.status === 'reg' && t.startAt) {
      if (!t.rem5 && now >= t.startAt - REMIND_MS && now < t.startAt) {
        t.rem5 = true;
        save();
        notifyPlayers(t, 'soon').catch(e => console.error('Ескерту қатесі:', e.message));
      }

      if (now >= t.startAt) {
        if (t.players.length >= 2) startTournament(t);
        else autoCancel(t).catch(e => console.error('Бас тарту қатесі:', e.message));
      }

      return;
    }

    if (t.status !== 'live') return;

    let changed = false;
    const round = curRound(t);
    const r = t.rounds.length - 1;

    for (let i = 0; i < round.length; i++) {
      const m = round[i];

      if (m.w || !m.a || !m.b) continue;

      // Сервер қайта қосылса, ойын жоғалады: матчты қайта «күту» күйіне қайтарамыз
      if (m.g && !games.has(m.g)) {
        m.g = null;
        m.ra = false;
        m.rb = false;
        m.dl = now + READY_MS;
        changed = true;
        continue;
      }

      if (m.g) continue;

      // Екеуі де «Дайынмын» басты, бірақ ойын ашылмай қалды: қайта көреміз
      if (m.ra && m.rb && tryStart(t, m, r, i)) {
        changed = true;
        continue;
      }

      if (m.dl > now) continue;

      // Уақыт бітті
      let w;

      if (m.ra && !m.rb) w = m.a;
      else if (m.rb && !m.ra) w = m.b;
      else if (m.ra && m.rb) {
        const oa = isOnline(users.get(m.a));
        const ob = isOnline(users.get(m.b));
        w = oa && !ob ? m.a : ob && !oa ? m.b : (!oa && !ob ? '-' : (Math.random() < 0.5 ? m.a : m.b));
      } else {
        w = '-';   // ешкім баспады: екі ойыншы да турнирден шығады
      }

      m.w = w;
      m.g = null;
      changed = true;
    }

    if (changed) {
      advance(t);
      save();
    }
  }

  /* ---------- Ойыншыға жіберілетін көрініс ---------- */

  function statusLabel(t) {
    return t.status;
  }

  function lite(userId) {
    userId = String(userId);
    const t = act();

    if (!t) {
      const l = data.last;
      const place = l && l.result
        ? (l.result.first === userId ? 1
          : l.result.second === userId ? 2
          : l.result.third.includes(userId) ? 3 : 0)
        : 0;

      return {
        t: 'tour_lite',
        v: data.v,
        on: false,
        last: l ? {
          id: l.id, name: l.name, place, coins: (l.paid && l.paid[userId]) || 0,
          kind: l.kind, gift: place === 1 && l.gift ? l.gift.stars || 0 : 0
        } : null
      };
    }

    const out = {
      t: 'tour_lite',
      v: data.v,
      on: true,
      id: t.id,
      name: t.name,
      status: statusLabel(t),
      count: t.players.length,
      size: t.size,
      joined: t.players.includes(userId),
      startText: t.startText,
      kind: t.kind,
      fee: t.fee,
      startAt: t.startAt || 0
    };

    if (t.status === 'live') {
      const f = findMatch(t, userId);
      out.alive = Boolean(f);
      out.myMatch = Boolean(f && f.m.a && f.m.b);
      out.myReady = Boolean(
        f && (f.m.a === userId ? f.m.ra : f.m.rb)
      );
      out.myPlaying = Boolean(f && f.m.g);
    }

    return out;
  }

  function full(userId) {
    userId = String(userId);
    const t = act();
    const base = lite(userId);

    base.t = 'tour';
    base.coins = shop.get(userId).coins;

    if (t) {
      base.prize1 = FREE_PRIZE;

      if (t.kind === 'stars') {
        const pool = poolOf(t);
        const tr = tiers();
        let est = 0;

        tr.forEach(x => { if (x <= pool) est = x; });

        base.pool = pool;
        base.tiers = tr;
        base.gift = est;
        loadGifts().catch(() => {});
      }

      if (t.status === 'reg') {
        base.players = t.players.slice(0, 60).map(nameOf);
      }

      if (t.status === 'live') {
        base.rounds = t.rounds.map(round =>
          round.map(m => ({
            a: m.a ? { id: m.a, name: nameOf(m.a) } : null,
            b: m.b ? { id: m.b, name: nameOf(m.b) } : null,
            w: m.w || null,
            play: Boolean(m.g)
          }))
        );

        const f = findMatch(t, userId);

        if (f && f.m.a && f.m.b) {
          const oppId = f.m.a === userId ? f.m.b : f.m.a;
          const oppProfile = profiles.get(String(oppId)) || {};

          base.my = {
            round: f.r,
            opp: { id: oppId, name: nameOf(oppId), avatar: oppProfile.avatar || null },
            ready: f.m.a === userId ? f.m.ra : f.m.rb,
            oppReady: f.m.a === userId ? f.m.rb : f.m.ra,
            playing: Boolean(f.m.g),
            left: Math.max(0, f.m.dl - Date.now())
          };
        }
      }
    }

    if (data.last) {
      const l = data.last;

      base.lastInfo = {
        name: l.name,
        first: nameOf(l.result.first),
        second: nameOf(l.result.second),
        third: l.result.third.map(nameOf),
        kind: l.kind,
        prize1: FREE_PRIZE,
        gift: l.gift || null
      };
    }

    return base;
  }

  /* ---------- Барлығына қысқа жаңарту (баннер) ---------- */

  function pushSoon() {
    if (pushTimer) return;

    pushTimer = setTimeout(() => {
      pushTimer = null;

      for (const u of users.values()) {
        if (isOnline(u)) send(u, lite(u.id));
      }
    }, 800);
  }

  /* ---------- WebSocket (мини-app) ---------- */

  function ws(u, m) {
    const t = act();
    const id = String(u.id);

    switch (m.t) {
      case 'tour_get':
        return send(u, full(id));

      case 'tour_join': {
        if (!t || t.status !== 'reg') return send(u, { t: 'tour_err', code: 'closed' });
        if (t.players.includes(id)) return send(u, full(id));
        if (t.players.length >= t.size) return send(u, { t: 'tour_err', code: 'full' });
        if (isBanned(id)) return send(u, { t: 'tour_err', code: 'closed' });

        if (t.kind === 'stars') {
          // Telegram Stars invoice: төлем өткен соң onPaid() тіркейді
          telegramApi('createInvoiceLink', {
            title: ('🏆 ' + t.name).slice(0, 32),
            description: 'Shashka турнирі: кіру ақысы ' + t.fee + ' ⭐',
            payload: `tour:${id}:${t.id}`,
            currency: 'XTR',
            prices: [{ label: 'Турнир', amount: t.fee }]
          }).then(r => send(u, { t: 'invoice', url: r.result }))
            .catch(e => {
              console.error('Турнир invoice қатесі:', e.message);
              send(u, { t: 'pay_error' });
            });

          return;
        }

        t.players.push(id);
        save();

        return send(u, full(id));
      }

      case 'tour_leave': {
        if (!t || t.status !== 'reg' || !t.players.includes(id)) {
          return send(u, full(id));
        }

        if (t.kind === 'stars') {
          refundOne(t, id).then(ok => {
            if (!ok) return send(u, { t: 'tour_err', code: 'refund' });

            t.players = t.players.filter(x => x !== id);
            save();
            send(u, full(id));
          });

          return;
        }

        t.players = t.players.filter(x => x !== id);
        save();

        return send(u, full(id));
      }

      case 'tour_ready': {
        if (!t || t.status !== 'live') return send(u, full(id));

        const f = findMatch(t, id);

        if (!f || !f.m.a || !f.m.b || f.m.g) return send(u, full(id));

        if (f.m.a === id) f.m.ra = true;
        else f.m.rb = true;

        if (f.m.ra && f.m.rb) {
          if (!tryStart(t, f.m, f.r, f.i)) {
            // қарсылас офлайн немесе бос емес: күтеміз
            send(u, { t: 'tour_err', code: 'opp_busy' });
          }
        }

        save();

        return send(u, full(id));
      }
    }
  }

  /* ---------- Админ панель (Telegram бот) ---------- */

  const back = (cb, text) => ({ text: text || '🔙 Артқа', callback_data: cb });

  function fmtPrize(d) {
    return d.kind === 'stars'
      ? 'банкке сыятын ең қымбат подарок (жеңімпазға автоматты жіберіледі)'
      : `🥇 ${FREE_PRIZE} 🪙 (тек 1-орынға)`;
  }

  function fmtSummary(d) {
    return (
      `🏆 <b>${escapeHtml(d.name)}</b>\n` +
      `👥 Орын: ${d.size} ойыншы\n` +
      `${d.kind === 'stars' ? '⭐ Кіру: <b>' + d.fee + ' ⭐</b> (Telegram Stars)' : '🆓 Кіру: тегін'}\n` +
      `🎁 Жүлде: ${fmtPrize(d)}\n` +
      `⏰ Басталуы: ${escapeHtml(d.startText)}`
    );
  }

  async function show(ctx, text, rows) {
    return editAdminMessage(ctx.chatId, ctx.messageId, text, { inline_keyboard: rows });
  }

  async function menuScreen(ctx) {
    const t = act();
    const rows = [[{ text: '➕ Жаңа турнир', callback_data: 'adm:tour:new' }]];
    let bal = '';

    try {
      const r = await telegramApi('getMyStarBalance', {});
      bal = '\n💰 Бот Stars балансы: <b>' + ((r.result && r.result.amount) || 0) + ' ⭐</b>';
    } catch (e) {}

    if (t) rows.push([{ text: '📋 Белсенді турнирді басқару', callback_data: 'adm:tour:manage' }]);

    if (data.last && data.last.gift && data.last.gift.status === 'failed') {
      rows.push([{ text: '🎁 Подарокты қайта жіберу', callback_data: 'adm:tour:gift' }]);
    }

    rows.push([back('adm:home', '🔙 Басты мәзір')]);

    return show(
      ctx,
      '🏆 <b>Турнирлер</b>' + bal + '\n\nБелсенді турнир: ' + (t ? escapeHtml(t.name) : 'жоқ'),
      rows
    );
  }

  async function manageScreen(ctx) {
    const t = act();

    if (!t) return menuScreen(ctx);

    const even = t.players.length % 2 === 0 && t.players.length >= 2;
    const names = t.players.slice(0, 40).map((id, i) => `${i + 1}. ${escapeHtml(nameOf(id))} <code>${id}</code>`).join('\n');

    let text =
      `📋 <b>${escapeHtml(t.name)}</b>\n\n` +
      `Күйі: ${t.status === 'reg' ? '● тіркелу ашық' : '▶️ ойын жүріп жатыр'}\n` +
      `Тіркелді: <b>${t.players.length} / ${t.size}</b>` +
      (t.status === 'reg'
        ? (even ? ' ✅ жұп, бастауға болады' : ' ⚠️ жұп болуы керек (кемінде 2)')
        : '') +
      `\nТүрі: ${t.kind === 'stars' ? '⭐ ақылы · ' + t.fee + ' ⭐' : '🆓 тегін'}\n` +
      `Басталуы: ${escapeHtml(t.startText)}`;

    if (t.kind === 'stars') {
      const pool = poolOf(t);
      const g = await pickGift(pool);
      text += `\n💰 Банк: <b>${pool} ⭐</b>\n🎁 Қазіргі жүлде: ` +
        (g ? `${g.star_count} ⭐ подарок · ботта қалады: ${pool - g.star_count} ⭐` : `подарок жоқ → ${FREE_PRIZE} 🪙 койн`);
    } else {
      text += `\nЖүлде: 🥇 ${FREE_PRIZE} 🪙`;
    }

    if (t.status === 'live') {
      const round = curRound(t);
      const done = round.filter(m => m.w).length;
      text += `\n\nКезең: ${t.rounds.length} · аяқталды ${done}/${round.length}`;
    } else if (names) {
      text += '\n\n' + names;
    }

    const rows = [];

    if (t.status === 'reg') rows.push([{ text: '▶️ Қазір бастау', callback_data: 'adm:tour:start' }]);

    rows.push([
      { text: '🔄 Жаңарту', callback_data: 'adm:tour:manage' },
      { text: '❌ Бас тарту', callback_data: 'adm:tour:cancel' }
    ]);

    rows.push([back('adm:tour')]);

    return show(ctx, text, rows);
  }

  // Қадамдар: name (мәтін) -> size (мәтін) -> fee -> prizes -> time (мәтін) -> confirm
  function askName(adminId) {
    adminActions.set(adminId, { action: 'tour_name', draft: {} });
  }

  async function adminCallback(query, ctx) {
    const adminId = String(query.from.id);
    const d = String(query.data);
    const cb = (text, alert) => deps.answerCallback(query.id, text, alert);

    if (d === 'adm:tour') {
      adminActions.delete(adminId);
      await menuScreen(ctx);
      await cb();
      return true;
    }

    if (d === 'adm:tour:new') {
      if (act()) {
        await cb('Алдымен белсенді турнирді аяқтаңыз немесе бас тартыңыз.', true);
        return true;
      }

      askName(adminId);

      await show(ctx,
        '🏆 <b>ЖАҢА ТУРНИР</b>\n\n<b>1/5</b> · Турнир атын жазыңыз:\n\n❌ Болдырмау: /cancel',
        [[back('adm:tour')]]
      );
      await cb('Атын жазыңыз');
      return true;
    }

    const state = adminActions.get(adminId);
    const draft = state && state.draft;

    const askTime = () => show(ctx,
      '<b>5/5</b> · Басталу уақытын жазыңыз:\n\n' +
      'Мысалы: <b>22:30</b> (өтіп кетсе ертеңге қойылады) немесе <b>20.11 19:30</b>.\n' +
      'Турнир сол уақытта <b>автоматты басталады</b>, 5 минут бұрын ойыншыларға ескерту барады. Ерте бастағыңыз келсе, «Қазір бастау» батырмасын басыңыз.\n\n❌ Болдырмау: /cancel',
      [[back('adm:tour')]]
    );

    if (d === 'adm:tour:ty:free' && draft) {
      draft.kind = 'free';
      draft.fee = 0;
      adminActions.set(adminId, { action: 'tour_time', draft });
      await askTime();
      await cb();
      return true;
    }

    if (d === 'adm:tour:ty:stars' && draft) {
      draft.kind = 'stars';
      adminActions.set(adminId, { action: 'tour_none', draft });

      await show(ctx,
        '<b>4/5</b> · Кіру ақысы (Telegram Stars):\n\nМысалы: 8 адам × 5 ⭐ = 40 ⭐ банк → 25 ⭐ подарок.',
        [
          STARS_FEES.slice(0, 2).map(n => ({ text: n + ' ⭐', callback_data: 'adm:tour:fee:' + n })),
          STARS_FEES.slice(2).map(n => ({ text: n + ' ⭐', callback_data: 'adm:tour:fee:' + n })),
          [back('adm:tour')]
        ]
      );
      await cb();
      return true;
    }

    if (d.startsWith('adm:tour:fee:') && draft) {
      const n = Number(d.split(':')[3]);

      if (!STARS_FEES.includes(n)) {
        await cb();
        return true;
      }

      draft.kind = 'stars';
      draft.fee = n;
      adminActions.set(adminId, { action: 'tour_time', draft });
      await askTime();
      await cb();
      return true;
    }

    if (d === 'adm:tour:pub' && draft && draft.startText) {
      if (act()) {
        await cb('Белсенді турнир бар.', true);
        return true;
      }

      data.seq += 1;

      data.active = {
        id: data.seq,
        name: draft.name,
        size: draft.size,
        kind: draft.kind === 'stars' ? 'stars' : 'free',
        fee: draft.kind === 'stars' ? draft.fee : 0,
        startText: draft.startText,
        startAt: draft.startAt || 0,
        status: 'reg',
        players: [],
        pay: {},
        rounds: [],
        createdAt: Date.now()
      };

      adminActions.delete(adminId);
      save();

      await show(ctx,
        '✅ <b>Турнир жарияланды!</b>\n\n' +
        'Турнир басталғанда тіркелгендерге жеке чатқа хабар барады.\n\n' +
        fmtSummary(data.active),
        [[{ text: '📋 Басқару', callback_data: 'adm:tour:manage' }], [back('adm:home', '‹ Менюге')]]
      );
      await cb('Жарияланды');
      return true;
    }

    if (d === 'adm:tour:manage') {
      await manageScreen(ctx);
      await cb();
      return true;
    }

    if (d === 'adm:tour:start') {
      const t = act();

      if (!t || t.status !== 'reg') {
        await cb('Турнир тіркелу күйінде емес.', true);
        return true;
      }

      if (t.players.length < 2 || t.players.length % 2 !== 0) {
        await cb(`Тіркелгендер саны жұп болуы керек (қазір ${t.players.length}).`, true);
        return true;
      }

      startTournament(t);

      await manageScreen(ctx);
      await cb('Турнир басталды!');
      return true;
    }

    if (d === 'adm:tour:cancel') {
      await show(ctx,
        '❌ <b>Турнирді бас тарту керек пе?</b>\n\n' + ((act() && act().kind === 'stars') ? 'Төленген Stars барлық ойыншыға қайтарылады.' : 'Тіркелгендер тізімі өшіріледі.'),
        [[
          { text: 'Иә, бас тарту', callback_data: 'adm:tour:cancelyes' },
          { text: 'Жоқ', callback_data: 'adm:tour:manage' }
        ]]
      );
      await cb();
      return true;
    }

    if (d === 'adm:tour:gift') {
      const l = data.last;

      if (l && l.gift && l.gift.status === 'failed') {
        await sendWinnerGift(l);
        await cb(l.gift.status === 'sent' ? 'Подарок жіберілді!' : 'Қайта жіберілмеді: ' + (l.gift.err || ''), true);
      } else {
        await cb();
      }

      await menuScreen(ctx);
      return true;
    }

    if (d === 'adm:tour:cancelyes') {
      const t = act();

      if (t) {
        let failed = 0;

        if (t.kind === 'stars') {
          for (const id of Object.keys(t.pay || {})) {
            if (!(await refundOne(t, id))) failed++;
            await sleep(60);
          }
        }

        if (failed) {
          save();
          await cb(`${failed} төлем қайтарылмады. Қайта басып көріңіз.`, true);
          return true;
        }

        data.active = null;
        save();
      }

      await menuScreen(ctx);
      await cb('Турнир бас тартылды');
      return true;
    }

    await cb();
    return true;
  }

  // Админ мәтін жіберген кезде (аты, орын саны, уақыт)
  async function adminText(message, action, adminId) {
    const chatId = message.chat.id;
    const input = String(message.text || '').trim();
    const draft = action.draft || {};
    const reply = (text, rows) => telegramApi('sendMessage', {
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      reply_markup: rows ? { inline_keyboard: rows } : undefined
    });

    if (input.startsWith('/')) {
      await reply('⚠️ Мәтін жіберіңіз, не /cancel жазыңыз.');
      return true;
    }

    if (action.action === 'tour_name') {
      draft.name = input.slice(0, 40);
      adminActions.set(adminId, { action: 'tour_size', draft });
      await reply(
        '<b>2/5</b> · Ең көбі неше ойыншы қатыса алады?\n\n' +
        'Санды өзіңіз жазыңыз (мысалы 36). Толық жиналмаса да, саны жұп болса бастауға болады.'
      );
      return true;
    }

    if (action.action === 'tour_size') {
      const n = parseInt(input, 10);

      if (!(n >= 2 && n <= 512)) {
        await reply('⚠️ 2 мен 512 арасындағы санды жазыңыз.');
        return true;
      }

      draft.size = n;
      adminActions.set(adminId, { action: 'tour_none', draft });
      await reply(
        '<b>3/5</b> · Турнир түрі:\n\n' +
        `🆓 <b>Тегін</b>: кіру тегін, жүлде тек 1-орынға ${FREE_PRIZE} койн.\n` +
        '⭐ <b>Ақылы</b>: Telegram Stars-пен кіреді, жеңімпазға банкке сәйкес подарок жіберіледі.',
        [[
          { text: '🆓 Тегін', callback_data: 'adm:tour:ty:free' },
          { text: '⭐ Ақылы (Stars)', callback_data: 'adm:tour:ty:stars' }
        ]]
      );
      return true;
    }

    if (action.action === 'tour_time') {
      const ps = parseStart(input);

      if (!ps) {
        await reply('⚠️ Уақыт түсініксіз. Мысалы: <b>22:30</b> немесе <b>20.11 19:30</b> (болашақта болуы керек).');
        return true;
      }

      draft.startAt = ps.at;
      draft.startText = ps.text;
      adminActions.set(adminId, { action: 'tour_none', draft });
      await reply('✅ <b>Тексеріңіз:</b>\n\n' + fmtSummary(draft), [
        [{ text: '✅ Жариялау', callback_data: 'adm:tour:pub' }],
        [{ text: '✏️ Өзгерту', callback_data: 'adm:tour:new' }, { text: '❌ Болдырмау', callback_data: 'adm:tour' }]
      ]);
      return true;
    }

    if (action.action === 'tour_none') {
      await reply('ℹ️ Төмендегі батырмаларды қолданыңыз немесе /cancel жазыңыз.');
      return true;
    }

    return false;
  }

  const timer = setInterval(tick, TICK_MS);
  if (timer.unref) timer.unref();

  return { load, lite, full, ws, onFinish, adminCallback, adminText, tick, joinFee, onPaid };
}

module.exports = { createTournament };
