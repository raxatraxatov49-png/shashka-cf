'use strict';
/* Ботты телефонда есептейтін Web Worker. lib/game.js + lib/bot.js-тен автоматты жасалған. */
const GAME = (function () {
  const module = { exports: {} };

/*
 * Rus shashkasi qoidalari (O'zbekistonda keng tarqalgan):
 *  - 8x8 doska, har tomonda 12 ta shashka, faqat to'q kataklarda
 *  - oq birinchi yuradi
 *  - urish majburiy; oddiy shashka oldinga ham, orqaga ham uradi
 *  - dama (uchuvchi): diagonal bo'ylab istalgan masofaga yuradi va uradi
 *  - zanjirli urish: bir yurishda davom etishi shart; oxirgi qatorga yetgan
 *    shashka urish paytida damaga aylanib, davom etadi
 *  - urilgan shashkalar yurish tugaguncha doskada turadi (bir shashkani 2 marta urib bo'lmaydi)
 *  - raqibda shashka yoki yurish qolmasa, u yutqazadi
 *  - 15 ta ketma-ket faqat dama yurishi (urishsiz) = durang
 *
 * Doska: 64 katak, index = row*8 + col. row 0 tepada (qora), row 7 pastda (oq).
 * To'q katak: (row+col) toq. Qiymatlar: null | 'w' | 'W' | 'b' | 'B' (katta harf = dama)
 */
const DIRS = [[-1, -1], [-1, 1], [1, -1], [1, 1]];
const inB = (r, c) => r >= 0 && r < 8 && c >= 0 && c < 8;
const sideOf = (p) => (p ? p.toLowerCase() : null);
const isKing = (p) => !!p && p === p.toUpperCase();
const other = (s) => (s === 'w' ? 'b' : 'w');
const QUIET_LIMIT = 30; // plies (15 yurish har tomondan)

function newGame() {
  const board = Array(64).fill(null);
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      if ((r + c) % 2 === 1) {
        if (r < 3) board[r * 8 + c] = 'b';
        else if (r > 4) board[r * 8 + c] = 'w';
      }
    }
  }
  return { board, turn: 'w', chain: null, quiet: 0, score: { w: 0, b: 0 }, over: null };
}

// Bitta shashkadan barcha mumkin bo'lgan "sakrash"lar (urishlar)
function jumps(board, from, captured) {
  const p = board[from];
  const me = sideOf(p);
  const king = isKing(p);
  const r0 = from >> 3, c0 = from & 7;
  const out = [];
  for (const [dr, dc] of DIRS) {
    let r = r0 + dr, c = c0 + dc;
    if (king) while (inB(r, c) && !board[r * 8 + c]) { r += dr; c += dc; }
    if (!inB(r, c)) continue;
    const ci = r * 8 + c;
    const t = board[ci];
    if (!t || sideOf(t) === me || captured.includes(ci)) continue;
    r += dr; c += dc;
    while (inB(r, c) && !board[r * 8 + c]) {
      out.push({ from, to: r * 8 + c, cap: ci });
      if (!king) break;
      r += dr; c += dc;
    }
  }
  return out;
}

// Yurishdan keyingi doska va shashka (oxirgi qatorda damaga aylanadi)
function landed(board, m) {
  const b = board.slice();
  const p = b[m.from];
  b[m.from] = null;
  const lastRow = sideOf(p) === 'w' ? 0 : 7;
  const np = (m.to >> 3) === lastRow ? p.toUpperCase() : p;
  b[m.to] = np;
  return { b, np, p };
}

function continues(board, m, captured) {
  const { b } = landed(board, m);
  return jumps(b, m.to, [...captured, m.cap]).length > 0;
}

// Dama bir nechta joyga qo'nishi mumkin bo'lsa va ba'zilaridan urish davom etsa — faqat shular ruxsat
function refine(board, caps, captured) {
  const groups = {};
  for (const m of caps) (groups[m.from + '-' + m.cap] ||= []).push(m);
  const res = [];
  for (const g of Object.values(groups)) {
    const cont = g.filter((m) => continues(board, m, captured));
    res.push(...(cont.length ? cont : g));
  }
  return res;
}

function simpleMoves(board, i) {
  const p = board[i];
  const r0 = i >> 3, c0 = i & 7;
  const out = [];
  if (isKing(p)) {
    for (const [dr, dc] of DIRS) {
      let r = r0 + dr, c = c0 + dc;
      while (inB(r, c) && !board[r * 8 + c]) { out.push({ from: i, to: r * 8 + c, cap: null }); r += dr; c += dc; }
    }
  } else {
    const dr = sideOf(p) === 'w' ? -1 : 1;
    for (const dc of [-1, 1]) {
      const r = r0 + dr, c = c0 + dc;
      if (inB(r, c) && !board[r * 8 + c]) out.push({ from: i, to: r * 8 + c, cap: null });
    }
  }
  return out;
}

function legalMoves(st) {
  if (st.over) return [];
  const { board, turn, chain } = st;
  let caps = [];
  if (chain) caps = jumps(board, chain.pos, chain.captured);
  else for (let i = 0; i < 64; i++) if (board[i] && sideOf(board[i]) === turn) caps.push(...jumps(board, i, []));
  if (caps.length) return refine(board, caps, chain ? chain.captured : []);
  if (chain) return [];
  const res = [];
  for (let i = 0; i < 64; i++) if (board[i] && sideOf(board[i]) === turn) res.push(...simpleMoves(board, i));
  return res;
}

function finishTurn(st) {
  st.turn = other(st.turn);
  const mine = st.board.filter((p) => sideOf(p) === st.turn).length;
  if (!mine) st.over = { winner: other(st.turn), reason: 'no_pieces' };
  else if (!legalMoves(st).length) st.over = { winner: other(st.turn), reason: 'no_moves' };
  else if (st.quiet >= QUIET_LIMIT) st.over = { winner: null, reason: 'draw' };
}

// Bitta qadam (bitta yurish yoki zanjirdagi bitta sakrash). Noqonuniy bo'lsa null.
function applyMove(st, from, to) {
  const m = legalMoves(st).find((x) => x.from === from && x.to === to);
  if (!m) return null;
  const mover = st.turn;
  const { b, np, p } = landed(st.board, m);
  st.board = b;
  const step = { from, to, cap: m.cap, king: np !== p, more: false };
  if (m.cap != null) {
    const ch = st.chain || { pos: from, captured: [] };
    ch.captured = [...ch.captured, m.cap];
    ch.pos = to;
    st.score[mover]++;
    st.quiet = 0;
    if (jumps(st.board, to, ch.captured).length) {
      st.chain = ch;
      step.more = true;
    } else {
      for (const i of ch.captured) st.board[i] = null;
      st.chain = null;
      finishTurn(st);
    }
  } else {
    st.quiet = isKing(p) ? st.quiet + 1 : 0;
    finishTurn(st);
  }
  return step;
}

// Mijozga ko'rsatiladigan doska (zanjir paytida urilganlar olib tashlangan)
function view(st) {
  const cap = st.chain ? st.chain.captured : [];
  return st.board.map((p, i) => (cap.includes(i) ? null : p));
}

module.exports = { newGame, legalMoves, applyMove, view, other, sideOf, isKing, jumps, landed, refine, simpleMoves };

  return module.exports;
})();
const B = (function () {
  const module = { exports: {} };
  const require = function () { return GAME; };


/*
 * Шашка боты (орыс шашкасы, lib/game.js ережелері).
 * Алгоритм: alpha-beta + итеративті тереңдету + транспозиция кестесі +
 * жеу кезінде ұзарту. Есептеу түйін санымен шектеледі (Cloudflare-де
 * синхронды кодта Date.now() өзгермейді, сондықтан тек уақытқа сенбейміз).
 *
 * bestMove(st, { nodes, ms }) -> { steps: [[from, to], ...], depth, score }
 */

const G = require('./game');

const sideOf = G.sideOf;
const isKing = G.isKing;
const other = G.other;

const MATE = 100000;
const QUIET = 30;
const TIMEOUT = { timeout: true };

/* ---------- Жүрістерді генерациялау (толық жүріс = тізбекті жеуді қоса) ---------- */

function expand(board, m, captured, steps, out) {
  const { b } = G.landed(board, m);
  const cap2 = captured.concat([m.cap]);
  const next = G.refine(b, G.jumps(b, m.to, cap2), cap2);
  const st2 = steps.concat([[m.from, m.to]]);

  if (next.length) {
    for (const n of next) expand(b, n, cap2, st2, out);
  } else {
    const fin = b.slice();

    for (const i of cap2) fin[i] = null;

    out.push({ steps: st2, board: fin, cap: cap2.length, kq: false, promo: false });
  }
}

function genFull(board, side) {
  const out = [];
  const caps = [];

  for (let i = 0; i < 64; i++) {
    const p = board[i];

    if (p && sideOf(p) === side) {
      const j = G.jumps(board, i, []);

      for (const m of j) caps.push(m);
    }
  }

  if (caps.length) {
    for (const m of G.refine(board, caps, [])) expand(board, m, [], [], out);

    return out;
  }

  for (let i = 0; i < 64; i++) {
    const p = board[i];

    if (!p || sideOf(p) !== side) continue;

    const king = isKing(p);

    for (const m of G.simpleMoves(board, i)) {
      const { b, np } = G.landed(board, m);

      out.push({ steps: [[m.from, m.to]], board: b, cap: 0, kq: king, promo: np !== p });
    }
  }

  return out;
}

function anyCapture(board, side) {
  for (let i = 0; i < 64; i++) {
    const p = board[i];

    if (p && sideOf(p) === side && G.jumps(board, i, []).length) return true;
  }

  return false;
}

/* ---------- Бағалау ---------- */

function evaluate(board, me) {
  let score = 0;
  let myN = 0;
  let oppN = 0;
  let total = 0;

  for (let i = 0; i < 64; i++) if (board[i]) total++;

  const endgame = total <= 8;

  for (let i = 0; i < 64; i++) {
    const p = board[i];

    if (!p) continue;

    const s = sideOf(p);
    const sign = s === me ? 1 : -1;
    const r = i >> 3;
    const c = i & 7;
    let v;

    if (isKing(p)) {
      v = endgame ? 360 : 330;

      // Үлкен жол (a1-h8) дамка үшін ең күшті
      if (r === c) v += endgame ? 28 : 14;
      else if (r + c === 7) v += 8;
      else if (c === 0 || c === 7 || r === 0 || r === 7) v -= 6;
    } else {
      const adv = s === 'w' ? 7 - r : r;

      v = 100 + adv * 5;

      if (adv === 6) v += 20;
      else if (adv === 5) v += 7;

      // Артқы қатардағы негізгі қорғаушылар (ақ: c1, e1; қара: d8, f8) дамка шығармауға көмектеседі
      if (!endgame) {
        if (s === 'w' && r === 7) v += (c === 2 || c === 4) ? 14 : 4;
        else if (s === 'b' && r === 0) v += (c === 3 || c === 5) ? 14 : 4;
      }

      // Орталық
      if (c >= 2 && c <= 5 && r >= 2 && r <= 5) v += 4;
      if (c >= 2 && c <= 5 && r >= 3 && r <= 4) v += 3;

      // Шеттегі тасты жеуге болмайды, бірақ ол белсенді емес
      if (c === 0 || c === 7) v -= 1;

      // Артында досы бар тас қауіпсіз (қорғалған)
      const br = s === 'w' ? r + 1 : r - 1;

      if (br >= 0 && br < 8) {
        if (c > 0) {
          const q = board[br * 8 + c - 1];
          if (q && sideOf(q) === s) v += 3;
        }

        if (c < 7) {
          const q = board[br * 8 + c + 1];
          if (q && sideOf(q) === s) v += 3;
        }
      }
    }

    if (s === me) myN++; else oppN++;

    score += sign * v;
  }

  // Артықшылығы барда айырбасты ұнатады, кем болса – қашады
  if (score > 150 && oppN) score += Math.round(60 / oppN);
  if (score < -150 && myN) score -= Math.round(60 / myN);

  return score + 4;   // жүріс кезегі аздап артықшылық
}

/* ---------- Транспозиция кестесі (хеш) ---------- */

const Z1 = new Int32Array(64 * 5);
const Z2 = new Int32Array(64 * 5);

for (let i = 0; i < Z1.length; i++) {
  Z1[i] = (Math.random() * 4294967296) | 0;
  Z2[i] = (Math.random() * 4294967296) | 0;
}

const PIDX = { w: 1, W: 2, b: 3, B: 4 };

function hashOf(board, side) {
  let h1 = side === 'w' ? 0x1234567 : 0x7654321;
  let h2 = side === 'w' ? 0x55aa : 0xaa55;

  for (let i = 0; i < 64; i++) {
    const p = board[i];

    if (p) {
      const k = i * 5 + PIDX[p];
      h1 ^= Z1[k];
      h2 ^= Z2[k];
    }
  }

  return (h1 >>> 0) * 2097152 + (h2 & 0x1fffff);
}

function order(moves, ttBest, killers) {
  for (const m of moves) {
    m.ord = m.cap * 10 + (m.promo ? 6 : 0) + (m.steps.length > 1 ? 2 : 0);

    if (killers && !m.cap) {
      const k = m.steps[0][0] * 64 + m.steps[0][1];

      if (k === killers[0]) m.ord += 50;
      else if (k === killers[1]) m.ord += 40;
    }

    if (ttBest && m.steps[0][0] === ttBest[0] && m.steps[0][1] === ttBest[1]) m.ord += 1000;
  }

  moves.sort((a, b) => b.ord - a.ord);
}

function createEngine(deadline, maxNodes) {
  const tt = new Map();
  const killers = [];
  let nodes = 0;

  function check() {
    if ((++nodes & 255) === 0 && (nodes > maxNodes || Date.now() > deadline)) throw TIMEOUT;
  }

  function search(board, side, depth, alpha, beta, ply, quiet, maxPly) {
    check();

    if (quiet >= QUIET) return 0;

    if (depth <= 0) {
      if (ply < maxPly && anyCapture(board, side)) depth = 1;
      else return evaluate(board, side);
    }

    const key = hashOf(board, side);
    const e = tt.get(key);
    let ttBest = null;

    if (e) {
      ttBest = e.best;

      if (e.depth >= depth) {
        if (e.flag === 0) return e.score;
        if (e.flag === 1 && e.score >= beta) return e.score;
        if (e.flag === 2 && e.score <= alpha) return e.score;
      }
    }

    const moves = genFull(board, side);

    if (!moves.length) return -MATE + ply;

    order(moves, ttBest, killers[ply]);

    const a0 = alpha;
    const opp = other(side);
    let best = -Infinity;
    let bestMove = null;

    let first = true;

    for (const m of moves) {
      const q = m.kq ? quiet + 1 : 0;
      let v;

      // Principal Variation Search: бірінші жүріс толық терезеде, қалғандары тар терезеде
      if (first) {
        v = -search(m.board, opp, depth - 1, -beta, -alpha, ply + 1, q, maxPly);
        first = false;
      } else {
        v = -search(m.board, opp, depth - 1, -alpha - 1, -alpha, ply + 1, q, maxPly);

        if (v > alpha && v < beta) {
          v = -search(m.board, opp, depth - 1, -beta, -alpha, ply + 1, q, maxPly);
        }
      }

      if (v > best) {
        best = v;
        bestMove = m.steps[0];
      }

      if (v > alpha) alpha = v;

      if (alpha >= beta) {
        if (!m.cap) {
          const k = m.steps[0][0] * 64 + m.steps[0][1];
          const kl = killers[ply] || (killers[ply] = [0, 0]);

          if (kl[0] !== k) {
            kl[1] = kl[0];
            kl[0] = k;
          }
        }

        break;
      }
    }

    if (tt.size > 250000) tt.clear();

    tt.set(key, { depth, score: best, flag: best <= a0 ? 2 : best >= beta ? 1 : 0, best: bestMove });

    return best;
  }

  return { search, get nodes() { return nodes; } };
}

function bestMove(st, opts) {
  const ms = (opts && opts.ms) || 700;
  const maxNodes = (opts && opts.nodes) || 60000;
  const maxDepth = (opts && opts.maxDepth) || 16;
  const deadline = Date.now() + ms;
  const side = st.turn;
  const opp = other(side);

  // Тізбекті жеудің ортасында болса, бір ғана заңды қадам береміз
  if (st.chain) {
    const lm = G.legalMoves(st);

    return lm.length ? { steps: [[lm[0].from, lm[0].to]], depth: 0, score: 0 } : null;
  }

  const root = genFull(st.board, side);

  if (!root.length) return null;
  if (root.length === 1) return { steps: root[0].steps, depth: 0, score: 0 };

  for (let i = root.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [root[i], root[j]] = [root[j], root[i]];
  }

  const eng = createEngine(deadline, maxNodes);
  const quick = createEngine(Infinity, Infinity);
  let best = root[0];
  let bestScore = 0;
  let doneDepth = 0;

  for (let depth = 1; depth <= maxDepth; depth++) {
    try {
      order(root, best && best.steps[0]);

      let alpha = -Infinity;
      let curBest = null;
      let curScore = -Infinity;

      for (const m of root) {
        const q = m.kq ? st.quiet + 1 : 0;
        const v = depth <= 2
          ? -quick.search(m.board, opp, depth - 1, -Infinity, -alpha, 1, q, depth + 8)
          : -eng.search(m.board, opp, depth - 1, -Infinity, -alpha, 1, q, depth + 8);

        if (v > curScore) {
          curScore = v;
          curBest = m;
        }

        if (v > alpha) alpha = v;
      }

      best = curBest;
      bestScore = curScore;
      doneDepth = depth;

      if (Math.abs(bestScore) > MATE - 200) break;
      if (Date.now() > deadline - ms * 0.15 || eng.nodes > maxNodes * 0.85) break;
    } catch (e) {
      if (e !== TIMEOUT) throw e;
      break;
    }
  }

  return { steps: best.steps, depth: doneDepth, score: bestScore };
}

module.exports = { bestMove, genFull, evaluate };

  return module.exports;
})();
onmessage = function (e) {
  const d = e.data || {};
  let steps = null;
  try {
    const r = B.bestMove(d.st, { nodes: d.nodes || 200000, ms: d.ms || 2500 });
    steps = r && r.steps;
  } catch (err) {}
  postMessage({ gid: d.gid, steps: steps });
};
