'use strict';

/*
 * Шашка боты (орыс шашкасы, lib/game.js ережелері).
 * Алгоритм: alpha-beta + итеративті тереңдету + транспозиция кестесі +
 * жеу кезінде ұзарту (capture extension). Әр жүріске уақыт шектеулі.
 *
 * bestMove(st, { ms }) -> { steps: [[from, to], ...], depth, score }
 * steps: бір толық жүріс (тізбекті жеу болса, бірнеше қадам).
 */

const G = require('./game');

const sideOf = G.sideOf;
const isKing = G.isKing;
const other = G.other;

const MATE = 100000;
const TIMEOUT = { timeout: true };

function clone(st) {
  return {
    board: st.board.slice(),
    turn: st.turn,
    chain: st.chain ? { pos: st.chain.pos, captured: st.chain.captured.slice() } : null,
    quiet: st.quiet,
    score: { w: st.score.w, b: st.score.b },
    over: st.over ? { winner: st.over.winner, reason: st.over.reason } : null
  };
}

// Бір толық жүріс (тізбекті жеуді қоса) және одан кейінгі күй
function fullMoves(st) {
  const side = st.turn;
  const out = [];

  (function rec(s, steps) {
    const ms = G.legalMoves(s);

    for (const m of ms) {
      const n = clone(s);
      const step = G.applyMove(n, m.from, m.to);

      if (!step) continue;

      const ns = steps.concat([[m.from, m.to]]);

      if (step.more && n.turn === side && !n.over) rec(n, ns);
      else out.push({ steps: ns, st: n, cap: n.score[side] - st.score[side] });
    }
  })(st, []);

  return out;
}

function hasCapture(st) {
  const ms = G.legalMoves(st);

  return ms.length > 0 && ms[0].cap != null;
}

function evaluate(st) {
  const me = st.turn;
  const board = st.board;
  let score = 0;
  let myMen = 0;
  let oppMen = 0;
  let myKings = 0;
  let oppKings = 0;

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

      // Дама үлкен диагональда күшті
      if (r === c || r + c === 7) v += 12;
      // Қырдағы дама әлсіз
      else if (c === 0 || c === 7 || r === 0 || r === 7) v -= 6;

      if (s === me) myKings++; else oppKings++;
    } else {
      const adv = s === 'w' ? 7 - r : r;

      v = 100 + adv * 5;

      // Соңғы қатардағы қорғаушылар (дама шығармауға)
      if ((s === 'w' && r === 7) || (s === 'b' && r === 0)) v += 10;
      // Орталық
      if (c >= 2 && c <= 5 && r >= 2 && r <= 5) v += 4;
      // Шеттегі шашка баяу
      if (c === 0 || c === 7) v -= 3;
      // Дама болуға жақын
      if (adv === 6) v += 18;

      if (s === me) myMen++; else oppMen++;
    }

    score += sign * v;
  }

  // Артықшылығы барда айырбасты ұнатады
  const myTotal = myMen + myKings;
  const oppTotal = oppMen + oppKings;

  if (score > 150 && oppTotal) score += Math.round(60 / oppTotal);
  if (score < -150 && myTotal) score -= Math.round(60 / myTotal);

  return score;
}

function keyOf(st) {
  let k = st.turn;

  for (let i = 0; i < 64; i++) k += st.board[i] || '.';

  return k;
}

function order(moves, ttBest) {
  for (const m of moves) {
    m.ord = m.cap * 10 + (m.steps.length > 1 ? 2 : 0);
    if (ttBest && m.steps[0][0] === ttBest[0] && m.steps[0][1] === ttBest[1]) m.ord += 1000;
  }

  moves.sort((a, b) => b.ord - a.ord);
}

function createEngine(deadline) {
  const tt = new Map();
  let nodes = 0;

  function check() {
    if ((++nodes & 255) === 0 && Date.now() > deadline) throw TIMEOUT;
  }

  function search(st, depth, alpha, beta, ply, maxPly) {
    check();

    if (st.over) {
      if (st.over.winner === null) return 0;

      return st.over.winner === st.turn ? MATE - ply : -MATE + ply;
    }

    if (depth <= 0) {
      // Жеу міндетті болса, позицияны тыныштандырамыз
      if (ply < maxPly && hasCapture(st)) depth = 1;
      else return evaluate(st);
    }

    const key = keyOf(st);
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

    const moves = fullMoves(st);

    if (!moves.length) return -MATE + ply;

    order(moves, ttBest);

    const a0 = alpha;
    let best = -Infinity;
    let bestMove = null;

    for (const m of moves) {
      const v = -search(m.st, depth - 1, -beta, -alpha, ply + 1, maxPly);

      if (v > best) {
        best = v;
        bestMove = m.steps[0];
      }

      if (v > alpha) alpha = v;
      if (alpha >= beta) break;
    }

    if (tt.size > 250000) tt.clear();

    tt.set(key, {
      depth,
      score: best,
      flag: best <= a0 ? 2 : best >= beta ? 1 : 0,
      best: bestMove
    });

    return best;
  }

  return { search, tt, get nodes() { return nodes; } };
}

function bestMove(st, opts) {
  const ms = (opts && opts.ms) || 450;
  const maxDepth = (opts && opts.maxDepth) || 16;
  const start = Date.now();
  const deadline = start + ms;
  const eng = createEngine(deadline);
  const root = fullMoves(st);

  if (!root.length) return null;
  if (root.length === 1) return { steps: root[0].steps, depth: 0, score: 0 };

  // Бірдей бағалы жүрістер әртүрлі болуы үшін араластырамыз
  for (let i = root.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [root[i], root[j]] = [root[j], root[i]];
  }

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
        // 1-2 тереңдікте уақыт тексерусіз толық есептейміз (әрқашан дұрыс жүріс болу үшін)
        const v = depth <= 2
          ? -safeSearch(eng, m.st, depth - 1, -Infinity, -alpha, 1)
          : -eng.search(m.st, depth - 1, -Infinity, -alpha, 1, depth + 8);

        if (v > curScore) {
          curScore = v;
          curBest = m;
        }

        if (v > alpha) alpha = v;
      }

      best = curBest;
      bestScore = curScore;
      doneDepth = depth;

      // Жеңіс/жеңіліс анық болса, тереңдете берудің керегі жоқ
      if (Math.abs(bestScore) > MATE - 200) break;
      if (Date.now() > deadline - ms * 0.15) break;
    } catch (e) {
      if (e !== TIMEOUT) throw e;
      break;
    }
  }

  return { steps: best.steps, depth: doneDepth, score: bestScore };
}

// Алғашқы тереңдіктерде уақыт тосқауылын өшіріп іздеу
function safeSearch(eng, st, depth, alpha, beta, ply) {
  const big = createEngine(Infinity);
  return big.search(st, depth, alpha, beta, ply, depth + 8);
}

module.exports = { bestMove, fullMoves, evaluate, clone };
