'use strict';

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

  for (let i = 0; i < 64; i++) {
    const p = board[i];

    if (!p) continue;

    const s = sideOf(p);
    const sign = s === me ? 1 : -1;
    const r = i >> 3;
    const c = i & 7;
    let v;

    if (isKing(p)) {
      v = 330;

      if (r === c || r + c === 7) v += 12;
      else if (c === 0 || c === 7 || r === 0 || r === 7) v -= 6;
    } else {
      const adv = s === 'w' ? 7 - r : r;

      v = 100 + adv * 5;

      if ((s === 'w' && r === 7) || (s === 'b' && r === 0)) v += 10;
      if (c >= 2 && c <= 5 && r >= 2 && r <= 5) v += 4;
      if (c === 0 || c === 7) v -= 3;
      if (adv === 6) v += 18;
    }

    if (s === me) myN++; else oppN++;

    score += sign * v;
  }

  if (score > 150 && oppN) score += Math.round(60 / oppN);
  if (score < -150 && myN) score -= Math.round(60 / myN);

  return score;
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

function order(moves, ttBest) {
  for (const m of moves) {
    m.ord = m.cap * 10 + (m.promo ? 6 : 0) + (m.steps.length > 1 ? 2 : 0);

    if (ttBest && m.steps[0][0] === ttBest[0] && m.steps[0][1] === ttBest[1]) m.ord += 1000;
  }

  moves.sort((a, b) => b.ord - a.ord);
}

function createEngine(deadline, maxNodes) {
  const tt = new Map();
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

    order(moves, ttBest);

    const a0 = alpha;
    const opp = other(side);
    let best = -Infinity;
    let bestMove = null;

    for (const m of moves) {
      const v = -search(m.board, opp, depth - 1, -beta, -alpha, ply + 1, m.kq ? quiet + 1 : 0, maxPly);

      if (v > best) {
        best = v;
        bestMove = m.steps[0];
      }

      if (v > alpha) alpha = v;
      if (alpha >= beta) break;
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
