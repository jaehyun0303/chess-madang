import { Chess } from '/lib/chess.js';

const $ = (s) => document.querySelector(s);
const GLYPH = { k: '♚', q: '♛', r: '♜', b: '♝', n: '♞', p: '♟' };
const glyph = (t) => GLYPH[t] + '︎';
const CAT_NAME = { bullet: '⚡ 불릿', blitz: '🔥 블리츠', rapid: '⏱ 래피드' };
const START_COUNT = { p: 8, n: 2, b: 2, r: 2, q: 1 };
const PVAL = { p: 1, n: 3, b: 3, r: 5, q: 9 };

// ---------- 상태 ----------
let ws, me = null, tcs = [];
let game = null;          // 서버에서 받은 게임 정보
let chess = new Chess();  // 현재 게임 로직
let flipped = false;
let selected = null, legal = [];
let drag = null;
let clock = { w: 0, b: 0, turn: 'w', running: false, at: 0 };
let lastMove = null;
let oppDisconnected = false;
let idleBoard = true;

// ---------- 소리 ----------
let actx;
function beep(freq = 520, dur = 0.06, vol = 0.08) {
  try {
    actx = actx || new (window.AudioContext || window.webkitAudioContext)();
    const o = actx.createOscillator(), g = actx.createGain();
    o.type = 'triangle'; o.frequency.value = freq;
    g.gain.value = vol; g.gain.exponentialRampToValueAtTime(0.0001, actx.currentTime + dur);
    o.connect(g).connect(actx.destination); o.start(); o.stop(actx.currentTime + dur);
  } catch {}
}
const sndMove = () => beep(480, 0.07), sndCap = () => beep(320, 0.1, 0.12), sndEnd = () => { beep(400, 0.15); setTimeout(() => beep(300, 0.25), 150); };

// ---------- 유틸 ----------
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function toast(msg, ms = 2600) {
  const t = $('#toast'); t.textContent = msg; t.classList.remove('hidden');
  clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.add('hidden'), ms);
}
function fmtClock(ms) {
  if (ms < 10000) { const s = Math.floor(ms / 1000), t = Math.floor((ms % 1000) / 100); return `0:0${s}.${t}`; }
  const s = Math.ceil(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
const myColor = () => (game ? game.myColor : null);
const gameActive = () => game && !game.result;

// ---------- WebSocket ----------
function connect() {
  ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host);
  ws.onopen = () => ws.send(JSON.stringify({ type: 'hello', token: localStorage.getItem('chess_token') }));
  ws.onmessage = (e) => onMsg(JSON.parse(e.data));
  ws.onclose = () => { toast('연결이 끊겼어요. 다시 연결 중…', 4000); setTimeout(connect, 1500); };
}
const send = (o) => {
  if (ws && ws.readyState === 1) { ws.send(JSON.stringify(o)); return true; }
  toast('서버에 연결 중이에요. 잠시 후 다시 눌러주세요.');
  const e = $('#nickErr') || $('#chErr'); if (e) e.textContent = '서버에 연결 중이에요… 잠시 후 다시 시도하세요.';
  return false;
};
// 한글 조합 중 Enter 는 무시 (마지막 글자 누락 방지)
const onEnter = (fn) => (e) => { if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); fn(); } };

function onMsg(m) {
  switch (m.type) {
    case 'needNick': showNickModal(false); break;
    case 'me':
      me = m.user;
      if (m.token) localStorage.setItem('chess_token', m.token);
      if (m.tcs) { tcs = m.tcs; buildLobby(); }
      renderMe();
      if (!gameActive() && !game) renderBars();
      if (m.nickChanged) { closeModal(); toast('닉네임이 변경되었어요!'); }
      else if (!$('#modal').classList.contains('hidden') && modalKind === 'nick-first') closeModal();
      break;
    case 'nickError': { const e = $('#nickErr'); if (e) e.textContent = m.error; break; }
    case 'kicked': toast('다른 곳에서 접속해서 연결이 종료되었어요.', 6000); break;
    case 'online': $('#online').textContent = `접속 ${m.count}명 · 대국 중 ${m.playing}명`; break;
    case 'queue': onQueue(m); break;
    case 'game': startGameUI(m.game); break;
    case 'move': onServerMove(m); break;
    case 'over': onOver(m); break;
    case 'drawOffer': if (m.from !== myColor()) $('#drawBanner').classList.remove('hidden'); else toast('무승부를 제안했어요'); break;
    case 'drawDeclined': $('#drawBanner').classList.add('hidden'); toast('무승부 제안이 거절되었어요'); break;
    case 'players': renderPlayers(m.list); break;
    case 'challengeError': { const e = $('#chErr'); if (e) e.textContent = m.error; else toast(m.error); break; }
    case 'challengeSent': showWaiting(m); break;
    case 'challenge': showIncoming(m); break;
    case 'challengeEnd': hideChallenge(m.id); if (m.reason) toast(m.reason); break;
    case 'oppStatus': oppDisconnected = !m.connected; renderBars(); if (!m.connected) toast('상대 연결이 끊겼어요 (60초 후 승리 처리)'); break;
  }
}

// ---------- 헤더 / 모달 ----------
function renderMe() {
  const c = $('#meChip');
  c.classList.remove('hidden');
  c.innerHTML = `${esc(me.nick)} <small>${me.ratings.blitz.r}</small>`;
}
let modalKind = null;
function openModal(html, kind) { modalKind = kind; $('#modalBox').innerHTML = html; $('#modal').classList.remove('hidden'); }
function closeModal() { $('#modal').classList.add('hidden'); modalKind = null; }
$('#modal').addEventListener('mousedown', (e) => { if (e.target.id === 'modal' && modalKind !== 'nick-first') closeModal(); });

function showNickModal(change) {
  openModal(`
    ${change ? '<button class="x" id="mx">×</button>' : ''}
    <h2>${change ? '닉네임 변경' : '♞ 환영합니다!'}</h2>
    <p class="hint">${change ? '새 닉네임을 입력하세요.' : '게임에서 사용할 닉네임을 정해주세요. 가입 없이 바로 시작할 수 있어요.'}<br>2~16자, 한글·영문·숫자·_ 사용 가능</p>
    <input type="text" id="nickIn" maxlength="16" placeholder="닉네임" autocomplete="off" value="${change && me ? esc(me.nick) : ''}">
    <div class="err" id="nickErr"></div>
    <button class="btn primary big" id="nickOk">${change ? '변경하기' : '시작하기'}</button>`, change ? 'nick' : 'nick-first');
  const inp = $('#nickIn'); inp.focus(); inp.select();
  const go = () => {
    const v = inp.value.trim();
    if (!/^[A-Za-z0-9_가-힣]{2,16}$/.test(v)) { $('#nickErr').textContent = '2~16자의 한글·영문·숫자·_ 만 사용할 수 있어요. (공백·특수문자 불가)'; return; }
    $('#nickErr').textContent = '';
    send({ type: change ? 'nick' : 'register', nick: v });
  };
  $('#nickOk').onclick = go;
  inp.onkeydown = onEnter(go);
  if (change) $('#mx').onclick = closeModal;
}

async function showLeaderboard(cat = 'blitz') {
  const list = await (await fetch('/api/leaderboard?cat=' + cat)).json();
  openModal(`<button class="x" id="mx">×</button><h2>🏆 순위표</h2>
    <div class="tabs">${['bullet', 'blitz', 'rapid'].map((c) => `<button data-c="${c}" class="${c === cat ? 'on' : ''}">${CAT_NAME[c]}</button>`).join('')}</div>
    ${list.length ? `<table><tr><th>#</th><th>닉네임</th><th class="num">레이팅</th><th class="num">게임</th></tr>
    ${list.map((u, i) => `<tr><td>${i + 1}</td><td><a class="nick" data-n="${esc(u.nick)}">${esc(u.nick)}</a></td><td class="num"><b>${u.rating}</b></td><td class="num">${u.games}</td></tr>`).join('')}</table>`
      : '<p class="hint">아직 순위에 오른 플레이어가 없어요. 첫 번째 주인공이 되어보세요!</p>'}`, 'board');
  $('#mx').onclick = closeModal;
  document.querySelectorAll('.tabs button').forEach((b) => (b.onclick = () => showLeaderboard(b.dataset.c)));
  document.querySelectorAll('a.nick').forEach((a) => (a.onclick = () => showProfile(a.dataset.n)));
}

async function showProfile(nick) {
  const r = await fetch('/api/profile?nick=' + encodeURIComponent(nick));
  if (!r.ok) return toast('플레이어를 찾을 수 없어요');
  const u = await r.json();
  const isMe = me && me.nick.toLowerCase() === u.nick.toLowerCase();
  openModal(`<button class="x" id="mx">×</button>
    <h2>${esc(u.nick)} ${u.online ? '<small style="color:var(--green);font-size:13px">● 온라인</small>' : ''}</h2>
    <p class="hint">가입일 ${new Date(u.created).toLocaleDateString('ko-KR')} · ${u.stats.w}승 ${u.stats.d}무 ${u.stats.l}패</p>
    <div class="rgrid">${['bullet', 'blitz', 'rapid'].map((c) => `<div class="rbox"><small>${CAT_NAME[c]}</small><b>${u.ratings[c].r}</b><small>${u.ratings[c].n}게임</small></div>`).join('')}</div>
    ${isMe ? '<button class="btn" id="chNick">✏️ 닉네임 변경</button>' : ''}
    <h3>최근 게임</h3>
    ${u.history.length ? `<table>${u.history.map((h) => `<tr><td class="${h.result}">${{ W: '승', L: '패', D: '무' }[h.result]}</td><td>${esc(h.opp)}${h.bot ? ' 🤖' : ''} <span class="hint">(${h.oppRating})</span></td><td>${h.tc}</td><td class="num ${h.delta > 0 ? 'W' : h.delta < 0 ? 'L' : ''}">${h.rated ? (h.delta > 0 ? '+' : '') + h.delta : '연습'}</td></tr>`).join('')}</table>` : '<p class="hint">아직 기록이 없어요.</p>'}`, 'profile');
  $('#mx').onclick = closeModal;
  if (isMe) $('#chNick').onclick = () => showNickModal(true);
}

$('#meChip').onclick = () => me && showProfile(me.nick);
$('#navBoard').onclick = () => showLeaderboard();
$('#navPlay').onclick = () => { if (!gameActive()) showPanel('lobby'); };

// ---------- 친구 도전 ----------
let pendingChallenge = null;
function showChallengeModal() {
  const opts = tcs.map((t) => `<option value="${t.id}" ${t.id === '5+0' ? 'selected' : ''}>${t.id} (${CAT_NAME[t.cat]})</option>`).join('');
  openModal(`<button class="x" id="mx">×</button><h2>⚔ 친구에게 도전</h2>
    <p class="hint">상대가 접속 중이어야 해요. 닉네임을 입력하거나 아래 목록에서 고르세요.</p>
    <input type="text" id="chNick" maxlength="16" placeholder="상대 닉네임" autocomplete="off">
    <div class="row"><select id="chTc">${opts}</select></div>
    <label class="check"><input type="checkbox" id="chRated" checked> 레이팅 게임 (끄면 연습 게임)</label>
    <div class="err" id="chErr"></div>
    <button class="btn primary big" id="chGo">도전 신청</button>
    <h3>🟢 접속 중인 플레이어</h3><div class="plist" id="plist"><p class="hint">불러오는 중…</p></div>`, 'challenge');
  $('#mx').onclick = closeModal;
  const go = () => send({ type: 'challenge', nick: $('#chNick').value, tc: $('#chTc').value, rated: $('#chRated').checked });
  $('#chGo').onclick = go; $('#chNick').onkeydown = onEnter(go);
  send({ type: 'players' });
}
function renderPlayers(list) {
  const el = $('#plist'); if (!el) return;
  el.innerHTML = list.length ? list.map((p) => `<button data-n="${esc(p.nick)}"><span>${esc(p.nick)}${p.busy ? ' <small>(게임 중)</small>' : ''}</span><small>${p.blitz}</small></button>`).join('')
    : '<p class="hint">지금 접속 중인 다른 플레이어가 없어요. 친구에게 사이트 주소를 보내 보세요!</p>';
  el.querySelectorAll('button').forEach((b) => (b.onclick = () => { $('#chNick').value = b.dataset.n; $('#chNick').focus(); }));
}
function showWaiting(m) {
  closeModal();
  pendingChallenge = m.id;
  const c = $('#challengeCard');
  c.innerHTML = `<h3>⏳ ${esc(m.to)}님의 답을 기다리는 중…</h3><p>${m.tc} · ${m.rated ? '레이팅 게임' : '연습 게임'} · 30초 안에 응답하지 않으면 만료돼요</p>
    <div class="actions"><button class="btn" id="chCancel">신청 취소</button></div>`;
  c.classList.remove('hidden');
  $('#chCancel').onclick = () => send({ type: 'cancelChallenge', id: m.id });
}
function showIncoming(m) {
  beep(700, 0.15); setTimeout(() => beep(900, 0.15), 160);
  pendingChallenge = m.id;
  const c = $('#challengeCard');
  c.innerHTML = `<h3>⚔ ${esc(m.from)}님의 도전!</h3><p>레이팅 ${m.rating} · ${m.tc} · ${m.rated ? '레이팅 게임' : '연습 게임'}</p>
    <div class="actions"><button class="btn primary" id="chYes">수락</button><button class="btn" id="chNo">거절</button></div>`;
  c.classList.remove('hidden');
  $('#chYes').onclick = () => send({ type: 'acceptChallenge', id: m.id });
  $('#chNo').onclick = () => send({ type: 'declineChallenge', id: m.id });
}
function hideChallenge(id) { if (pendingChallenge === id) { $('#challengeCard').classList.add('hidden'); pendingChallenge = null; } }
$('#navChallenge').onclick = () => { if (!me) return; if (gameActive()) return toast('게임 중에는 도전할 수 없어요'); showChallengeModal(); };

// ---------- 로비 ----------
function buildLobby() {
  const groups = { bullet: [], blitz: [], rapid: [] };
  tcs.forEach((t) => groups[t.cat].push(t));
  $('#tcGroups').innerHTML = Object.entries(groups).map(([cat, list]) => `
    <div class="tcgroup"><div class="tchead"><span>${CAT_NAME[cat]}</span><b>${me ? me.ratings[cat].r : ''}</b></div>
    <div class="tcrow">${list.map((t) => `<button class="tcbtn" data-tc="${t.id}">${t.base / 60}분${t.inc ? ` +${t.inc}초` : ''}<small>${t.id}</small></button>`).join('')}</div></div>`).join('');
  document.querySelectorAll('.tcbtn').forEach((b) => (b.onclick = () => send({ type: 'queue', tc: b.dataset.tc, bot: $('#allowBot').checked })));
  $('#botTc').innerHTML = tcs.map((t) => `<option value="${t.id}" ${t.id === '10+0' ? 'selected' : ''}>${t.id}</option>`).join('');
}
$('#lvl').oninput = (e) => ($('#lvlVal').textContent = e.target.value);
document.querySelectorAll('#botColor button').forEach((b) => (b.onclick = () => {
  document.querySelectorAll('#botColor button').forEach((x) => x.classList.remove('on')); b.classList.add('on');
}));
$('#botStart').onclick = () => send({ type: 'playBot', tc: $('#botTc').value, level: $('#lvl').value, color: $('#botColor .on').dataset.c });
$('#cancelQueue').onclick = () => send({ type: 'cancelQueue' });

function showPanel(which) {
  ['lobby', 'queue', 'gamePanel'].forEach((id) => $('#' + id).classList.toggle('hidden', id !== which));
  if (which === 'lobby' && me) buildLobby();
}
function onQueue(m) {
  if (!m.tc) return showPanel('lobby');
  showPanel('queue');
  const bot = $('#allowBot').checked;
  $('#queueInfo').innerHTML = `${m.tc} · 대기 ${m.waited}초 · 대기열 ${m.size}명<br>${bot ? (m.waited >= 8 ? 'AI 상대 배정 중…' : '곧 상대가 없으면 AI와 대결해요') : '실제 플레이어를 기다리는 중'}`;
}

// ---------- 게임 ----------
function startGameUI(g) {
  game = g; idleBoard = false;
  chess = new Chess();
  lastMove = null;
  for (const m of g.moves) { chess.move({ from: m.f, to: m.t, promotion: m.p || undefined }); lastMove = m; }
  flipped = g.myColor === 'b';
  selected = null; legal = [];
  oppDisconnected = false;
  clock = { w: g.wTime, b: g.bTime, turn: g.turn, running: g.running, at: performance.now() };
  closeModal();
  $('#challengeCard').classList.add('hidden'); pendingChallenge = null;
  showPanel('gamePanel');
  $('#overCard').classList.add('hidden');
  $('#drawBanner').classList.add('hidden');
  $('#actions').classList.remove('hidden');
  $('#afterActions').classList.add('hidden');
  $('#board').classList.remove('over');
  if (g.result) showOver({ result: g.result, reason: g.reason });
  renderAll();
  if (g.moves.length === 0) { beep(600, 0.12); toast(`당신은 ${g.myColor === 'w' ? '백' : '흑'}입니다. 30초 안에 첫 수를 두세요!`); }
}

function onServerMove(m) {
  if (!game || m.gid !== game.id) return;
  if (m.ply > game.moves.length) {
    const mv = chess.move({ from: m.m.f, to: m.m.t, promotion: m.m.p || undefined });
    game.moves.push(m.m); lastMove = m.m;
    mv && mv.captured ? sndCap() : sndMove();
    selected = null; legal = [];
  }
  clock = { w: m.wTime, b: m.bTime, turn: m.turn, running: m.running, at: performance.now() };
  game.turn = m.turn;
  $('#drawBanner').classList.add('hidden');
  renderAll();
}

function onOver(m) {
  if (!game || m.gid !== game.id) return;
  game.result = m.result; game.reason = m.reason;
  clock.running = false;
  showOver(m);
  sndEnd();
  renderAll();
}

function showOver(m) {
  const c = myColor();
  let title, cls = '';
  if (m.result === 'aborted') title = '게임 취소';
  else if (m.result === '1/2-1/2') title = '무승부';
  else { const won = (m.result === '1-0') === (c === 'w'); title = won ? '🎉 승리!' : '패배'; }
  let delta = '';
  if (m.change && m.rated) {
    const d = m.change.delta;
    delta = `<div class="delta ${d > 0 ? 'pos' : d < 0 ? 'neg' : ''}">${d > 0 ? '+' : ''}${d}</div><p>${CAT_NAME[m.cat]} 레이팅 <b>${m.change.rating}</b></p>`;
  } else if (m.result !== 'aborted') delta = `<p>${game.rated ? '' : '연습 게임 · 레이팅 변동 없음'}</p>`;
  $('#overCard').innerHTML = `<h3>${title}</h3><p>${esc(m.reason || '')}</p>${delta}`;
  $('#overCard').classList.remove('hidden');
  $('#actions').classList.add('hidden');
  $('#drawBanner').classList.add('hidden');
  $('#afterActions').classList.remove('hidden');
  $('#board').classList.add('over');
}

$('#newGame').onclick = () => { game = null; idleBoard = true; chess = new Chess(); lastMove = null; selected = null; legal = []; flipped = false; showPanel('lobby'); renderAll(); };
$('#resign').onclick = () => { if (gameActive() && (game.moves.length < 2 || confirm('정말 기권하시겠어요?'))) send({ type: 'resign' }); };
$('#draw').onclick = () => gameActive() && send({ type: 'offerDraw' });
$('#drawYes').onclick = () => send({ type: 'acceptDraw' });
$('#drawNo').onclick = () => { send({ type: 'declineDraw' }); $('#drawBanner').classList.add('hidden'); };
$('#flip').onclick = $('#flip2').onclick = () => { flipped = !flipped; renderAll(); };

// ---------- 렌더링 ----------
function renderAll() { renderBoard(); renderBars(); renderMoves(); }

const sqName = (row, col) => {
  const f = flipped ? 7 - col : col, r = flipped ? row + 1 : 8 - row;
  return 'abcdefgh'[f] + r;
};

function renderBoard() {
  const b = $('#board');
  const pos = chess.board(); // [rank8..rank1][a..h]
  const inCheck = chess.inCheck() ? chess.turn() : null;
  let html = '';
  for (let row = 0; row < 8; row++) for (let col = 0; col < 8; col++) {
    const name = sqName(row, col);
    const f = 'abcdefgh'.indexOf(name[0]), r = parseInt(name[1]);
    const p = pos[8 - r][f];
    const light = (f + r) % 2 === 1;
    const cls = ['sq', light ? 'l' : 'd'];
    if (lastMove && (lastMove.f === name || lastMove.t === name)) cls.push('last');
    if (selected === name) cls.push('sel');
    const isLegal = legal.find((m) => m.to === name);
    if (isLegal && p) cls.push('cap');
    if (inCheck && p && p.type === 'k' && p.color === inCheck) cls.push('check');
    html += `<div class="${cls.join(' ')}" data-sq="${name}">
      ${col === 0 ? `<span class="co r">${r}</span>` : ''}${row === 7 ? `<span class="co f">${name[0]}</span>` : ''}
      ${isLegal ? '<i class="dot"></i>' : ''}
      ${p ? `<span class="pc ${p.color}" data-sq="${name}">${glyph(p.type)}</span>` : ''}</div>`;
  }
  b.innerHTML = html;
}

function captured(color) {
  // color 가 잡은 상대 기물
  const opp = color === 'w' ? 'b' : 'w';
  const cnt = { p: 0, n: 0, b: 0, r: 0, q: 0 };
  for (const row of chess.board()) for (const p of row) if (p && p.color === opp && p.type !== 'k') cnt[p.type]++;
  let list = '', mat = 0;
  for (const t of ['q', 'r', 'b', 'n', 'p']) {
    list += glyph(t).repeat(Math.max(0, START_COUNT[t] - cnt[t]));
  }
  const sum = (c) => { let s = 0; for (const row of chess.board()) for (const p of row) if (p && p.color === c && p.type !== 'k') s += PVAL[p.type]; return s; };
  mat = sum(color) - sum(opp);
  return { list, mat };
}

function bar(info, color, showColorDot) {
  if (!info) return `<div class="avatar">?</div><div class="pinfo"><div class="pname">대기 중</div></div><div class="clock">--:--</div>`;
  const cap = captured(color);
  return `<div class="avatar" style="background:${info.bot ? '#4b6a8a' : '#6b5d4a'}">${info.bot ? '🤖' : esc(info.nick[0].toUpperCase())}</div>
    <div class="pinfo"><div class="pname">${esc(info.nick)}${info.bot ? '<span class="badge">AI</span>' : ''} <span class="rt">(${info.rating})</span>
      ${showColorDot ? '' : ''}${color !== myColor() && oppDisconnected ? '<span class="dcflag"> ● 연결 끊김</span>' : ''}</div>
      <div class="capt">${cap.list}${cap.mat > 0 ? `<i>+${cap.mat}</i>` : ''}</div></div>
    <div class="clock" data-c="${color}">--:--</div>`;
}

function renderBars() {
  const top = $('#topBar'), bot = $('#botBar');
  if (!game) {
    const mine = me ? { nick: me.nick, rating: me.ratings.blitz.r } : null;
    top.innerHTML = bar(null, 'b'); bot.innerHTML = bar(mine, 'w');
    return updateClocks();
  }
  const topColor = flipped ? 'w' : 'b', botColor = flipped ? 'b' : 'w';
  const info = (c) => (c === 'w' ? game.white : game.black);
  top.innerHTML = bar(info(topColor), topColor); bot.innerHTML = bar(info(botColor), botColor);
  updateClocks();
}

function renderMoves() {
  const el = $('#moves');
  if (!game) { el.innerHTML = ''; return; }
  const tc = game.tc;
  $('#gameInfo').innerHTML = `<span><b>${tc.id}</b> · ${CAT_NAME[tc.cat]}</span><span>${game.rated ? '레이팅 게임' : '연습 게임'}</span>`;
  let html = '';
  game.moves.forEach((m, i) => {
    if (i % 2 === 0) html += `<span class="n">${i / 2 + 1}.</span>`;
    html += `<span class="${i === game.moves.length - 1 ? 'cur' : ''}">${esc(m.s)}</span>`;
  });
  if (game.moves.length % 2 === 1) html += '<span></span>';
  el.innerHTML = html;
  el.scrollTop = el.scrollHeight;
}

function updateClocks() {
  const now = performance.now();
  document.querySelectorAll('.clock[data-c]').forEach((el) => {
    const c = el.dataset.c;
    let ms = game ? clock[c] : 0;
    const active = game && clock.running && clock.turn === c && !game.result;
    if (active) ms = Math.max(0, ms - (now - clock.at));
    if (!game) { el.textContent = '--:--'; return; }
    el.textContent = fmtClock(ms);
    el.classList.toggle('active', !!active || (game && !game.result && !clock.running && clock.turn === c));
    el.classList.toggle('low', !!active && ms < 10000);
  });
}
setInterval(updateClocks, 100);

// ---------- 입력 (클릭 / 드래그) ----------
function canMove() {
  return gameActive() && chess.turn() === myColor() && game.moves.length === chess.history().length;
}
function selectSquare(sq) {
  const p = chess.get(sq);
  if (p && p.color === myColor() && canMove()) {
    selected = sq; legal = chess.moves({ square: sq, verbose: true });
  } else { selected = null; legal = []; }
}

function tryMove(from, to) {
  const mv = legal.find((m) => m.from === from && m.to === to);
  if (!mv) return false;
  if (mv.promotion) { askPromotion(from, to, mv.color); return true; }
  doMove(from, to);
  return true;
}

function doMove(from, to, promotion) {
  const mv = chess.move({ from, to, promotion });
  if (!mv) return;
  const m = { f: mv.from, t: mv.to, s: mv.san, p: mv.promotion || null };
  game.moves.push(m); lastMove = m; selected = null; legal = [];
  mv.captured ? sndCap() : sndMove();
  // 낙관적 시계 전환
  const now = performance.now();
  if (clock.running) clock[mv.color] = Math.max(0, clock[mv.color] - (now - clock.at));
  clock.turn = chess.turn(); clock.at = now; if (game.moves.length >= 2) clock.running = true;
  send({ type: 'move', from, to, promotion });
  renderAll();
}

function askPromotion(from, to, color) {
  const pr = $('#promo');
  const bs = $('#board').getBoundingClientRect(), w = bs.width / 8;
  const toEl = document.querySelector(`.sq[data-sq="${to}"]`).getBoundingClientRect();
  const atTop = toEl.top - bs.top < bs.height / 2;
  pr.style.left = toEl.left - bs.left + 'px';
  pr.style.top = atTop ? toEl.top - bs.top + 'px' : bs.height - w * 4 - (bs.height - (toEl.top - bs.top) - w) + 'px';
  pr.style.flexDirection = atTop ? 'column' : 'column-reverse';
  if (!atTop) pr.style.top = toEl.top - bs.top + w - w * 4 + 'px';
  pr.innerHTML = ['q', 'n', 'r', 'b'].map((t) => `<button data-t="${t}"><span class="pc">${glyph(t)}</span></button>`).join('');
  pr.classList.remove('hidden');
  pr.querySelectorAll('button').forEach((b) => (b.onclick = () => { pr.classList.add('hidden'); doMove(from, to, b.dataset.t); }));
  pr.dataset.open = '1';
}

const boardEl = $('#board');
boardEl.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 && e.pointerType === 'mouse') return;
  $('#promo').classList.add('hidden');
  const sqEl = e.target.closest('.sq'); if (!sqEl || !game) return;
  const sq = sqEl.dataset.sq;
  if (!canMove()) return;
  // 이미 선택된 상태에서 목적지 클릭
  if (selected && selected !== sq && legal.some((m) => m.to === sq)) { tryMove(selected, sq); return; }
  const wasSelected = selected === sq;
  selectSquare(sq);
  renderBoard();
  if (selected && e.target.classList.contains('pc')) {
    const pc = document.querySelector(`.pc[data-sq="${sq}"]`);
    drag = { from: sq, wasSelected, moved: false, x: e.clientX, y: e.clientY, ghost: null, pc };
  }
});
window.addEventListener('pointermove', (e) => {
  if (!drag) return;
  if (!drag.moved && Math.hypot(e.clientX - drag.x, e.clientY - drag.y) > 5) {
    drag.moved = true;
    const g = drag.pc.cloneNode(true); g.className = drag.pc.className + ' ghost'; document.body.appendChild(g);
    drag.ghost = g; drag.pc.style.opacity = '.25';
  }
  if (drag.ghost) { drag.ghost.style.left = e.clientX + 'px'; drag.ghost.style.top = e.clientY + 'px'; }
});
window.addEventListener('pointerup', (e) => {
  if (!drag) return;
  const d = drag; drag = null;
  if (d.ghost) d.ghost.remove();
  if (d.moved) {
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const to = el && el.closest && el.closest('.sq') && el.closest('.sq').dataset.sq;
    if (to && to !== d.from && tryMove(d.from, to)) return;
    selected = null; legal = []; renderBoard();
  } else if (d.wasSelected) { selected = null; legal = []; renderBoard(); }
});

window.addEventListener('keydown', (e) => { if (e.key === 'Escape') { selected = null; legal = []; renderBoard(); } });

// ---------- 시작 ----------
renderAll();
connect();
