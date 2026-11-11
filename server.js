const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { Chess } = require('chess.js');
const { chooseMove } = require('./bot');

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

// ---------- 설정 ----------
const TIME_CONTROLS = {
  '1+0': { id: '1+0', base: 60, inc: 0, cat: 'bullet' },
  '2+1': { id: '2+1', base: 120, inc: 1, cat: 'bullet' },
  '3+0': { id: '3+0', base: 180, inc: 0, cat: 'blitz' },
  '3+2': { id: '3+2', base: 180, inc: 2, cat: 'blitz' },
  '5+0': { id: '5+0', base: 300, inc: 0, cat: 'blitz' },
  '10+0': { id: '10+0', base: 600, inc: 0, cat: 'rapid' },
  '15+10': { id: '15+10', base: 900, inc: 10, cat: 'rapid' },
  '30+0': { id: '30+0', base: 1800, inc: 0, cat: 'rapid' },
};
const CATS = ['bullet', 'blitz', 'rapid'];
const START_RATING = 1200;
const BOT_NAMES = ['알파미니', '나이트봇', '룩앤롤', '폰스타', '퀸마스터', '딥블루주니어', '체스로봇', '킹슬레이어', '비숍킴', '캐슬링'];
const ABORT_MS = 30000;
const RECONNECT_MS = 60000;
const BOT_FALLBACK_MS = 8000;

// ---------- DB ----------
let db = { users: {}, games: 0 };
try {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(DB_FILE)) db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
} catch (e) {
  console.error('DB 로드 실패, 새로 시작합니다', e.message);
}
let saveTimer = null;
function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      fs.writeFileSync(DB_FILE + '.tmp', JSON.stringify(db));
      fs.renameSync(DB_FILE + '.tmp', DB_FILE);
    } catch (e) {
      console.error('DB 저장 실패', e.message);
    }
  }, 400);
}
function saveNow() {
  try { fs.writeFileSync(DB_FILE, JSON.stringify(db)); } catch {}
}
process.on('SIGINT', () => { saveNow(); process.exit(0); });
process.on('SIGTERM', () => { saveNow(); process.exit(0); });

const tokenIndex = new Map(); // token -> userId
const nickIndex = new Map(); // lower nick -> userId
for (const u of Object.values(db.users)) {
  tokenIndex.set(u.token, u.id);
  nickIndex.set(u.nick.toLowerCase(), u.id);
}

function validNick(nick) {
  if (typeof nick !== 'string') return '닉네임이 올바르지 않습니다.';
  nick = nick.trim();
  if (!/^[A-Za-z0-9_가-힣]{2,16}$/.test(nick)) return '닉네임은 2~16자의 한글, 영문, 숫자, _ 만 사용할 수 있어요.';
  return null;
}

function newUser(nick) {
  const id = crypto.randomBytes(6).toString('hex');
  const token = crypto.randomBytes(24).toString('hex');
  const ratings = {};
  for (const c of CATS) ratings[c] = { r: START_RATING, n: 0 };
  const u = { id, token, nick, ratings, stats: { w: 0, l: 0, d: 0 }, history: [], created: Date.now() };
  db.users[id] = u;
  tokenIndex.set(token, id);
  nickIndex.set(nick.toLowerCase(), id);
  save();
  return u;
}

function publicUser(u) {
  return { nick: u.nick, ratings: u.ratings, stats: u.stats, created: u.created };
}

// ---------- 접속 관리 ----------
const sockets = new Map(); // userId -> ws
const userGame = new Map(); // userId -> gameId
const games = new Map(); // gameId -> game
let queue = []; // {userId, tc, since, bot}
const challenges = new Map(); // id -> {id, from, to, tc, rated, timer}

function endChallenge(id, reason) {
  const c = challenges.get(id);
  if (!c) return;
  clearTimeout(c.timer);
  challenges.delete(id);
  for (const uid of [c.from, c.to]) sendUser(uid, { type: 'challengeEnd', id, reason });
}
function dropChallengesOf(userId, reason) {
  for (const c of [...challenges.values()]) if (c.from === userId || c.to === userId) endChallenge(c.id, reason);
}

function send(ws, msg) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
}
function sendUser(userId, msg) {
  send(sockets.get(userId), msg);
}

let onlineTimer = null;
function broadcastOnline() {
  if (onlineTimer) return;
  onlineTimer = setTimeout(() => {
    onlineTimer = null;
    const msg = JSON.stringify({ type: 'online', count: sockets.size, playing: games.size * 2 });
    for (const ws of sockets.values()) if (ws.readyState === 1) ws.send(msg);
  }, 300);
}

// ---------- 레이팅 ----------
function expected(a, b) {
  return 1 / (1 + Math.pow(10, (b - a) / 400));
}
function kFactor(n, r) {
  if (n < 20) return 40;
  if (r >= 2200) return 16;
  return 24;
}

// ---------- 게임 ----------
function playerInfo(p, cat) {
  if (p.bot) return { nick: p.nick, rating: p.rating, bot: true };
  const u = db.users[p.userId];
  return { nick: u.nick, rating: u.ratings[cat].r, bot: false };
}

function remaining(g, color, now) {
  let t = g.times[color];
  if (!g.result && g.moves.length >= 2 && g.chess.turn() === color) t -= now - g.lastTs;
  return Math.max(0, t);
}

function gameState(g, myColor) {
  const now = Date.now();
  return {
    id: g.id,
    white: g.white.info,
    black: g.black.info,
    tc: g.tc,
    rated: g.rated,
    moves: g.moves,
    fen: g.chess.fen(),
    turn: g.chess.turn(),
    wTime: remaining(g, 'w', now),
    bTime: remaining(g, 'b', now),
    running: g.moves.length >= 2 && !g.result,
    result: g.result,
    reason: g.reason,
    drawOffer: g.drawOffer,
    myColor,
  };
}

function colorOf(g, userId) {
  if (g.white.userId === userId) return 'w';
  if (g.black.userId === userId) return 'b';
  return null;
}

function createGame(a, b, tc, rated) {
  // a, b: {userId} 또는 {bot:true, nick, rating}
  const id = crypto.randomBytes(5).toString('hex');
  const [white, black] = Math.random() < 0.5 ? [a, b] : [b, a];
  return startGame(id, white, black, tc, rated);
}

function startGame(id, white, black, tc, rated) {
  const g = {
    id, tc, rated,
    white, black,
    chess: new Chess(),
    moves: [],
    times: { w: tc.base * 1000, b: tc.base * 1000 },
    lastTs: Date.now(),
    result: null, reason: null,
    drawOffer: null,
    timer: null,
    dcTimers: {},
  };
  white.info = playerInfo(white, tc.cat);
  black.info = playerInfo(black, tc.cat);
  games.set(id, g);
  for (const p of [white, black]) {
    if (!p.bot) {
      userGame.set(p.userId, id);
      removeFromQueue(p.userId);
    }
  }
  for (const [p, c] of [[white, 'w'], [black, 'b']]) {
    if (!p.bot) sendUser(p.userId, { type: 'game', game: gameState(g, c) });
  }
  scheduleTimer(g);
  maybeBotMove(g);
  broadcastOnline();
  return g;
}

function scheduleTimer(g) {
  clearTimeout(g.timer);
  if (g.result) return;
  const turn = g.chess.turn();
  if (g.moves.length < 2) {
    g.timer = setTimeout(() => finish(g, 'aborted', turn === 'w' ? '백이 첫 수를 두지 않았습니다' : '흑이 첫 수를 두지 않았습니다'), ABORT_MS);
  } else {
    const ms = Math.max(0, g.times[turn] - (Date.now() - g.lastTs)) + 30;
    g.timer = setTimeout(() => onTimeout(g, turn), ms);
  }
}

function onTimeout(g, color) {
  if (g.result) return;
  const now = Date.now();
  if (remaining(g, color, now) > 50) return scheduleTimer(g);
  // 상대에게 킹만 남았다면 무승부
  const opp = color === 'w' ? 'b' : 'w';
  let oppPieces = 0;
  for (const row of g.chess.board()) for (const p of row) if (p && p.color === opp) oppPieces++;
  if (oppPieces <= 1) return finish(g, '1/2-1/2', '시간 초과 (상대 기물 부족)');
  finish(g, color === 'w' ? '0-1' : '1-0', '시간 초과');
}

function applyMove(g, color, from, to, promotion) {
  if (g.result || g.chess.turn() !== color) return null;
  let mv;
  try {
    mv = g.chess.move({ from, to, promotion });
  } catch {
    return null;
  }
  if (!mv) return null;
  const now = Date.now();
  if (g.moves.length >= 2) {
    g.times[color] -= now - g.lastTs;
    if (g.times[color] <= 0) {
      g.times[color] = 0;
      g.chess.undo();
      onTimeout(g, color);
      return null;
    }
    g.times[color] += g.tc.inc * 1000;
  }
  g.lastTs = now;
  const m = { f: mv.from, t: mv.to, s: mv.san, p: mv.promotion || null };
  g.moves.push(m);
  g.drawOffer = null;
  const payload = {
    type: 'move', gid: g.id, ply: g.moves.length, m,
    fen: g.chess.fen(), turn: g.chess.turn(),
    wTime: remaining(g, 'w', now), bTime: remaining(g, 'b', now),
    running: g.moves.length >= 2,
  };
  for (const p of [g.white, g.black]) if (!p.bot) sendUser(p.userId, payload);

  // 종료 판정
  const c = g.chess;
  if (c.isCheckmate()) return finish(g, color === 'w' ? '1-0' : '0-1', '체크메이트'), mv;
  if (c.isStalemate()) return finish(g, '1/2-1/2', '스테일메이트'), mv;
  if (c.isInsufficientMaterial()) return finish(g, '1/2-1/2', '기물 부족'), mv;
  if (c.isThreefoldRepetition()) return finish(g, '1/2-1/2', '3회 동형 반복'), mv;
  if (c.isDrawByFiftyMoves()) return finish(g, '1/2-1/2', '50수 규칙'), mv;
  scheduleTimer(g);
  maybeBotMove(g);
  return mv;
}

function maybeBotMove(g) {
  if (g.result) return;
  const color = g.chess.turn();
  const p = color === 'w' ? g.white : g.black;
  if (!p.bot) return;
  const think = 400 + Math.random() * 1100;
  const delay = Math.min(think, Math.max(100, g.times[color] * 0.04));
  setTimeout(() => {
    if (g.result || g.chess.turn() !== color) return;
    const m = chooseMove(g.chess.fen(), p.rating);
    if (m) applyMove(g, color, m.from, m.to, m.promotion);
  }, delay);
}

function finish(g, result, reason) {
  if (g.result) return;
  g.result = result;
  g.reason = reason;
  clearTimeout(g.timer);
  for (const t of Object.values(g.dcTimers)) clearTimeout(t);

  const changes = { w: null, b: null };
  const rated = g.rated && result !== 'aborted';
  const score = result === '1-0' ? 1 : result === '0-1' ? 0 : 0.5;
  const cat = g.tc.cat;
  const rw = g.white.info.rating, rb = g.black.info.rating;

  const upd = (p, color, s, oppRating, oppInfo) => {
    if (p.bot) return;
    const u = db.users[p.userId];
    const entry = u.ratings[cat];
    let delta = 0;
    if (rated) {
      delta = Math.round(kFactor(entry.n, entry.r) * (s - expected(entry.r, oppRating)));
      entry.r = Math.max(100, entry.r + delta);
      entry.n++;
    }
    if (result !== 'aborted') {
      if (s === 1) u.stats.w++; else if (s === 0) u.stats.l++; else u.stats.d++;
      u.history.unshift({
        t: Date.now(), opp: oppInfo.nick, bot: oppInfo.bot, oppRating,
        color, result: s === 1 ? 'W' : s === 0 ? 'L' : 'D', delta, rated, tc: g.tc.id,
        moves: g.moves.length,
      });
      u.history.length = Math.min(u.history.length, 30);
    }
    changes[color] = { delta, rating: entry.r };
  };
  upd(g.white, 'w', score, rb, g.black.info);
  upd(g.black, 'b', 1 - score, rw, g.white.info);
  if (result !== 'aborted') db.games++;
  save();

  for (const [p, c] of [[g.white, 'w'], [g.black, 'b']]) {
    if (p.bot) continue;
    sendUser(p.userId, { type: 'over', gid: g.id, result, reason, rated, change: changes[c], cat });
    sendUser(p.userId, { type: 'me', user: publicUser(db.users[p.userId]) });
    if (userGame.get(p.userId) === g.id) userGame.delete(p.userId);
  }
  setTimeout(() => games.delete(g.id), 5000);
  broadcastOnline();
}

// ---------- 매칭 ----------
function removeFromQueue(userId) {
  const before = queue.length;
  queue = queue.filter((q) => q.userId !== userId);
  return before !== queue.length;
}

function matchLoop() {
  const now = Date.now();
  const used = new Set();
  // 실제 플레이어끼리 먼저 매칭
  for (let i = 0; i < queue.length; i++) {
    const a = queue[i];
    if (used.has(a.userId)) continue;
    let best = null, bestDiff = Infinity;
    for (let j = i + 1; j < queue.length; j++) {
      const b = queue[j];
      if (used.has(b.userId) || b.tc !== a.tc) continue;
      const cat = TIME_CONTROLS[a.tc].cat;
      const diff = Math.abs(db.users[a.userId].ratings[cat].r - db.users[b.userId].ratings[cat].r);
      const waited = (now - Math.min(a.since, b.since)) / 1000;
      const allowed = 100 + waited * 50;
      if (diff <= allowed && diff < bestDiff) { best = b; bestDiff = diff; }
    }
    if (best) {
      used.add(a.userId); used.add(best.userId);
      createGame({ userId: a.userId }, { userId: best.userId }, TIME_CONTROLS[a.tc], true);
    }
  }
  queue = queue.filter((q) => !used.has(q.userId));
  // 오래 기다린 사람은 AI와 매칭
  for (const q of [...queue]) {
    if (q.bot && now - q.since >= BOT_FALLBACK_MS) {
      const tc = TIME_CONTROLS[q.tc];
      const myRating = db.users[q.userId].ratings[tc.cat].r;
      const rating = Math.max(400, Math.min(2200, Math.round((myRating + (Math.random() - 0.5) * 200) / 50) * 50));
      removeFromQueue(q.userId);
      createGame({ userId: q.userId }, { bot: true, nick: BOT_NAMES[Math.floor(Math.random() * BOT_NAMES.length)], rating }, tc, true);
    }
  }
  for (const q of queue) {
    sendUser(q.userId, { type: 'queue', tc: q.tc, waited: Math.round((now - q.since) / 1000), size: queue.length });
  }
}
setInterval(matchLoop, 1000);

// ---------- HTTP ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
const PUBLIC = path.join(__dirname, 'public');

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/api/leaderboard') {
    const cat = CATS.includes(url.searchParams.get('cat')) ? url.searchParams.get('cat') : 'blitz';
    const list = Object.values(db.users)
      .filter((u) => u.ratings[cat].n > 0)
      .sort((a, b) => b.ratings[cat].r - a.ratings[cat].r)
      .slice(0, 50)
      .map((u) => ({ nick: u.nick, rating: u.ratings[cat].r, games: u.ratings[cat].n }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(list));
  }
  if (url.pathname === '/api/profile') {
    const id = nickIndex.get((url.searchParams.get('nick') || '').toLowerCase());
    if (!id) { res.writeHead(404); return res.end('{}'); }
    const u = db.users[id];
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ...publicUser(u), history: u.history.slice(0, 15), online: sockets.has(id) }));
  }
  let file;
  if (url.pathname === '/lib/chess.js') file = path.join(__dirname, 'node_modules/chess.js/dist/esm/chess.js');
  else {
    const p = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname);
    file = path.join(PUBLIC, path.normalize(p).replace(/^(\.\.[/\\])+/, ''));
    if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
});

// ---------- WebSocket ----------
const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  ws.userId = null;
  ws.isAlive = true;
  ws.on('pong', () => (ws.isAlive = true));

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    try { handle(ws, msg); } catch (e) { console.error(e); }
  });

  ws.on('close', () => {
    if (!ws.userId || sockets.get(ws.userId) !== ws) return;
    const uid = ws.userId;
    sockets.delete(uid);
    removeFromQueue(uid);
    dropChallengesOf(uid, '상대가 접속을 종료했어요');
    const g = games.get(userGame.get(uid));
    if (g && !g.result) {
      const c = colorOf(g, uid);
      const oppBot = (c === 'w' ? g.black : g.white).bot;
      // 연습(비레이팅) AI 게임은 바로 정리
      g.dcTimers[c] = setTimeout(() => finish(g, oppBot && !g.rated ? 'aborted' : c === 'w' ? '0-1' : '1-0', '접속 끊김'), RECONNECT_MS);
      const opp = c === 'w' ? g.black : g.white;
      if (!opp.bot) sendUser(opp.userId, { type: 'oppStatus', gid: g.id, connected: false });
    }
    broadcastOnline();
  });
});

setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 20000);

function login(ws, u) {
  const old = sockets.get(u.id);
  if (old && old !== ws) { send(old, { type: 'kicked' }); old.userId = null; old.close(); }
  ws.userId = u.id;
  sockets.set(u.id, ws);
  send(ws, { type: 'me', user: publicUser(u), token: u.token, tcs: Object.values(TIME_CONTROLS) });
  const g = games.get(userGame.get(u.id));
  if (g && !g.result) {
    const c = colorOf(g, u.id);
    clearTimeout(g.dcTimers[c]);
    send(ws, { type: 'game', game: gameState(g, c) });
    const opp = c === 'w' ? g.black : g.white;
    if (!opp.bot) sendUser(opp.userId, { type: 'oppStatus', gid: g.id, connected: true });
  }
  broadcastOnline();
}

function handle(ws, msg) {
  switch (msg.type) {
    case 'hello': {
      const id = tokenIndex.get(msg.token);
      if (!id) return send(ws, { type: 'needNick' });
      return login(ws, db.users[id]);
    }
    case 'register': {
      const err = validNick(msg.nick);
      if (err) return send(ws, { type: 'nickError', error: err });
      const nick = msg.nick.trim();
      if (nickIndex.has(nick.toLowerCase())) return send(ws, { type: 'nickError', error: '이미 사용 중인 닉네임이에요.' });
      return login(ws, newUser(nick));
    }
  }
  if (!ws.userId) return;
  const u = db.users[ws.userId];

  switch (msg.type) {
    case 'nick': {
      const err = validNick(msg.nick);
      if (err) return send(ws, { type: 'nickError', error: err });
      const nick = msg.nick.trim();
      const existing = nickIndex.get(nick.toLowerCase());
      if (existing && existing !== u.id) return send(ws, { type: 'nickError', error: '이미 사용 중인 닉네임이에요.' });
      nickIndex.delete(u.nick.toLowerCase());
      u.nick = nick;
      nickIndex.set(nick.toLowerCase(), u.id);
      save();
      return send(ws, { type: 'me', user: publicUser(u), nickChanged: true });
    }
    case 'queue': {
      const tc = TIME_CONTROLS[msg.tc];
      if (!tc || userGame.has(u.id)) return;
      removeFromQueue(u.id);
      queue.push({ userId: u.id, tc: tc.id, since: Date.now(), bot: msg.bot !== false });
      send(ws, { type: 'queue', tc: tc.id, waited: 0, size: queue.length });
      return;
    }
    case 'cancelQueue':
      removeFromQueue(u.id);
      return send(ws, { type: 'queue', tc: null });
    case 'playBot': {
      const tc = TIME_CONTROLS[msg.tc];
      if (!tc || userGame.has(u.id)) return;
      removeFromQueue(u.id);
      const level = Math.max(400, Math.min(2200, parseInt(msg.level) || 1000));
      const bot = { bot: true, nick: `컴퓨터 ${level}`, rating: level };
      const me = { userId: u.id };
      let pair = [me, bot];
      if (msg.color === 'b') pair = [bot, me];
      else if (msg.color !== 'w') pair = Math.random() < 0.5 ? [me, bot] : [bot, me];
      startGame(crypto.randomBytes(5).toString('hex'), pair[0], pair[1], tc, false);
      return;
    }
    case 'players': {
      const list = [];
      for (const [uid, sock] of sockets) {
        if (uid === u.id || sock.readyState !== 1) continue;
        const o = db.users[uid];
        list.push({ nick: o.nick, blitz: o.ratings.blitz.r, busy: userGame.has(uid) });
      }
      list.sort((a, b) => a.busy - b.busy || b.blitz - a.blitz);
      return send(ws, { type: 'players', list: list.slice(0, 50) });
    }
    case 'challenge': {
      const tc = TIME_CONTROLS[msg.tc];
      if (!tc) return;
      const fail = (error) => send(ws, { type: 'challengeError', error });
      const tid = nickIndex.get(String(msg.nick || '').trim().toLowerCase());
      if (!tid) return fail('그런 닉네임의 플레이어가 없어요.');
      if (tid === u.id) return fail('자기 자신에게는 도전할 수 없어요.');
      if (!sockets.has(tid)) return fail('상대가 지금 접속 중이 아니에요.');
      if (userGame.has(u.id)) return fail('게임 중에는 도전할 수 없어요.');
      if (userGame.has(tid)) return fail('상대가 지금 다른 게임 중이에요.');
      for (const c of [...challenges.values()]) if (c.from === u.id) endChallenge(c.id, '도전을 취소했어요');
      const id = crypto.randomBytes(4).toString('hex');
      const c = { id, from: u.id, to: tid, tc, rated: msg.rated !== false };
      c.timer = setTimeout(() => endChallenge(id, '시간이 지나 도전이 만료되었어요'), 30000);
      challenges.set(id, c);
      const t = db.users[tid];
      send(ws, { type: 'challengeSent', id, to: t.nick, tc: tc.id, rated: c.rated });
      return sendUser(tid, { type: 'challenge', id, from: u.nick, rating: u.ratings[tc.cat].r, tc: tc.id, rated: c.rated });
    }
    case 'cancelChallenge': {
      const c = challenges.get(msg.id);
      if (c && c.from === u.id) endChallenge(c.id, '도전을 취소했어요');
      return;
    }
    case 'declineChallenge': {
      const c = challenges.get(msg.id);
      if (c && c.to === u.id) endChallenge(c.id, `${u.nick}님이 도전을 거절했어요`);
      return;
    }
    case 'acceptChallenge': {
      const c = challenges.get(msg.id);
      if (!c || c.to !== u.id) return;
      if (userGame.has(c.from) || userGame.has(c.to) || !sockets.has(c.from)) return endChallenge(c.id, '대국을 시작할 수 없어요');
      clearTimeout(c.timer);
      challenges.delete(c.id);
      return void createGame({ userId: c.from }, { userId: c.to }, c.tc, c.rated);
    }
    case 'move': {
      const g = games.get(userGame.get(u.id));
      if (!g) return;
      const c = colorOf(g, u.id);
      const ok = applyMove(g, c, msg.from, msg.to, msg.promotion);
      if (!ok && !g.result) send(ws, { type: 'game', game: gameState(g, c) }); // 재동기화
      return;
    }
    case 'resign': {
      const g = games.get(userGame.get(u.id));
      if (!g || g.result) return;
      const c = colorOf(g, u.id);
      return finish(g, g.moves.length < 2 ? 'aborted' : c === 'w' ? '0-1' : '1-0', g.moves.length < 2 ? '게임이 취소되었습니다' : '기권');
    }
    case 'offerDraw': {
      const g = games.get(userGame.get(u.id));
      if (!g || g.result || g.moves.length < 2) return;
      const c = colorOf(g, u.id);
      const opp = c === 'w' ? g.black : g.white;
      if (opp.bot) {
        // 봇은 자신이 불리하거나 후반에 동점 근처면 수락
        const accept = g.moves.length > 60 || Math.random() < 0.15;
        return accept ? finish(g, '1/2-1/2', '합의 무승부') : send(ws, { type: 'drawDeclined' });
      }
      g.drawOffer = c;
      send(ws, { type: 'drawOffer', from: c });
      return sendUser(opp.userId, { type: 'drawOffer', from: c });
    }
    case 'acceptDraw': {
      const g = games.get(userGame.get(u.id));
      if (!g || g.result || !g.drawOffer) return;
      if (g.drawOffer === colorOf(g, u.id)) return;
      return finish(g, '1/2-1/2', '합의 무승부');
    }
    case 'declineDraw': {
      const g = games.get(userGame.get(u.id));
      if (!g || !g.drawOffer) return;
      g.drawOffer = null;
      for (const p of [g.white, g.black]) if (!p.bot) sendUser(p.userId, { type: 'drawDeclined' });
      return;
    }
  }
}

server.listen(PORT, () => console.log(`체스 서버 실행 중: http://localhost:${PORT}`));
