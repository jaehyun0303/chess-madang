// 간단한 체스 AI (알파-베타 탐색 + 레이팅별 약화)
const { Chess } = require('chess.js');

const VAL = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 0 };

// 간단한 위치 보너스 (백 기준, a8=0 ... h1=63 순서)
const PST = {
  p: [0,0,0,0,0,0,0,0, 50,50,50,50,50,50,50,50, 10,10,20,30,30,20,10,10, 5,5,10,25,25,10,5,5,
      0,0,0,20,20,0,0,0, 5,-5,-10,0,0,-10,-5,5, 5,10,10,-20,-20,10,10,5, 0,0,0,0,0,0,0,0],
  n: [-50,-40,-30,-30,-30,-30,-40,-50, -40,-20,0,0,0,0,-20,-40, -30,0,10,15,15,10,0,-30, -30,5,15,20,20,15,5,-30,
      -30,0,15,20,20,15,0,-30, -30,5,10,15,15,10,5,-30, -40,-20,0,5,5,0,-20,-40, -50,-40,-30,-30,-30,-30,-40,-50],
  b: [-20,-10,-10,-10,-10,-10,-10,-20, -10,0,0,0,0,0,0,-10, -10,0,5,10,10,5,0,-10, -10,5,5,10,10,5,5,-10,
      -10,0,10,10,10,10,0,-10, -10,10,10,10,10,10,10,-10, -10,5,0,0,0,0,5,-10, -20,-10,-10,-10,-10,-10,-10,-20],
  r: [0,0,0,0,0,0,0,0, 5,10,10,10,10,10,10,5, -5,0,0,0,0,0,0,-5, -5,0,0,0,0,0,0,-5,
      -5,0,0,0,0,0,0,-5, -5,0,0,0,0,0,0,-5, -5,0,0,0,0,0,0,-5, 0,0,0,5,5,0,0,0],
  q: [-20,-10,-10,-5,-5,-10,-10,-20, -10,0,0,0,0,0,0,-10, -10,0,5,5,5,5,0,-10, -5,0,5,5,5,5,0,-5,
      0,0,5,5,5,5,0,-5, -10,5,5,5,5,5,0,-10, -10,0,5,0,0,0,0,-10, -20,-10,-10,-5,-5,-10,-10,-20],
  k: [-30,-40,-40,-50,-50,-40,-40,-30, -30,-40,-40,-50,-50,-40,-40,-30, -30,-40,-40,-50,-50,-40,-40,-30, -30,-40,-40,-50,-50,-40,-40,-30,
      -20,-30,-30,-40,-40,-30,-30,-20, -10,-20,-20,-20,-20,-20,-20,-10, 20,20,0,0,0,0,20,20, 20,30,10,0,0,10,30,20],
};

function evaluate(chess) {
  // 백 관점 점수
  let score = 0;
  const board = chess.board();
  for (let r = 0; r < 8; r++) {
    for (let f = 0; f < 8; f++) {
      const p = board[r][f];
      if (!p) continue;
      const idx = r * 8 + f;
      if (p.color === 'w') score += VAL[p.type] + PST[p.type][idx];
      else score -= VAL[p.type] + PST[p.type][(7 - r) * 8 + f];
    }
  }
  return score;
}

function orderMoves(moves) {
  return moves
    .map((m) => {
      let s = 0;
      if (m.captured) s += 10 * VAL[m.captured] - VAL[m.piece] / 10 + 1000;
      if (m.promotion) s += 800;
      if (m.san.includes('+')) s += 50;
      return { m, s };
    })
    .sort((a, b) => b.s - a.s)
    .map((x) => x.m);
}

function search(chess, depth, alpha, beta, ctx) {
  ctx.nodes++;
  if (chess.isCheckmate()) return -100000 - depth;
  if (chess.isDraw()) return 0;
  if (depth === 0) {
    const e = evaluate(chess);
    return chess.turn() === 'w' ? e : -e;
  }
  if (ctx.nodes > ctx.maxNodes) {
    const e = evaluate(chess);
    return chess.turn() === 'w' ? e : -e;
  }
  const moves = orderMoves(chess.moves({ verbose: true }));
  let best = -Infinity;
  for (const m of moves) {
    chess.move(m);
    const sc = -search(chess, depth - 1, -beta, -alpha, ctx);
    chess.undo();
    if (sc > best) best = sc;
    if (best > alpha) alpha = best;
    if (alpha >= beta) break;
  }
  return best;
}

// rating: 약 400 ~ 2200
function chooseMove(fen, rating) {
  const chess = new Chess(fen);
  const moves = chess.moves({ verbose: true });
  if (!moves.length) return null;
  const depth = rating < 700 ? 1 : rating < 1500 ? 2 : 3;
  const noise = Math.max(0, (2000 - rating) / 4); // 약할수록 큰 노이즈
  const blunder = rating < 1000 ? (1000 - rating) / 1500 : 0; // 낮은 레이팅은 가끔 아무 수나 둠
  if (Math.random() < blunder) return moves[Math.floor(Math.random() * moves.length)];

  const ctx = { nodes: 0, maxNodes: 12000 };
  let bestMove = moves[0];
  let bestScore = -Infinity;
  for (const m of orderMoves(moves)) {
    chess.move(m);
    let sc = -search(chess, depth - 1, -Infinity, Infinity, ctx);
    chess.undo();
    sc += (Math.random() - 0.5) * 2 * noise;
    if (sc > bestScore) {
      bestScore = sc;
      bestMove = m;
    }
  }
  return bestMove;
}

module.exports = { chooseMove };
