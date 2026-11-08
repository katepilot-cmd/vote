'use strict';
// 종강파티 실시간 투표 서버 — 외부 패키지 없이 Node.js만으로 동작합니다.
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 3000;
const ROOT = __dirname;
const PUB = path.join(ROOT, 'public');
const F_Q = path.join(ROOT, 'questions.txt');
const F_R = path.join(ROOT, 'roster.txt');
const F_D = path.join(ROOT, 'data.json');

const TYPE_MAP = {
  '객관식': 'choice', '동기': 'person', '사람': 'person', '숫자': 'number',
  '단답': 'short', '주관식': 'short', '메시지': 'long', '서술': 'long',
};

function readText(f, def = '') { try { return fs.readFileSync(f, 'utf8'); } catch { return def; } }

// 쉼표로 나누되 괄호 안의 쉼표는 무시: "감면(감염, 류마, 알레)" 는 보기 하나
function splitOptions(str) {
  const out = []; let cur = '', depth = 0;
  for (const ch of str) {
    if ('(（['.includes(ch)) depth++;
    if (')）]'.includes(ch)) depth = Math.max(0, depth - 1);
    if (ch === ',' && depth === 0) { out.push(cur); cur = ''; } else cur += ch;
  }
  out.push(cur);
  return out.map(s => s.trim()).filter(Boolean);
}

function parseQuestions(text) {
  const out = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    let parts = line.split('|').map(s => s.trim());
    // '| 5분', '| 90초' 처럼 적으면 그 질문만 제한시간 따로
    let time = null;
    parts = parts.filter((p, idx) => {
      const m = idx > 1 && p.match(/^(\d+)\s*(초|분)$/);
      if (m) { time = Number(m[1]) * (m[2] === '분' ? 60 : 1); return false; }
      return true;
    });
    let type = TYPE_MAP[parts[0]];
    let title, options = [];
    if (!type) { type = 'short'; title = line; }
    else {
      title = parts[1] || '';
      if (parts.length > 2) options = splitOptions(parts.slice(2).join(','));
      options = [...new Set(options)];
    }
    if (!title) continue;
    if (type === 'choice' && options.length < 2) type = 'short';
    out.push({ type, title, options, time });
  }
  return out;
}

function parseRoster(text) {
  const seen = new Set();
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    for (const n0 of line.split(',')) { const n = n0.trim(); if (n) seen.add(n.slice(0, 20)); }
  }
  return [...seen].sort((a, b) => a.localeCompare(b, 'ko'));
}

// ---------- 상태 ----------
let questionsText = readText(F_Q);
let rosterText = process.env.ROSTER || readText(F_R);
let Q = parseQuestions(questionsText);
let R = parseRoster(rosterText);

const D = {
  hostKey: '', settings: { timeChoice: 120, timeText: 120, autoClose: false },
  cur: -1, phase: 'lobby', endsAt: 0, answers: {}, players: {},
};
try { const saved = JSON.parse(readText(F_D, '{}')); Object.assign(D, saved); D.settings = { timeChoice: 120, timeText: 120, autoClose: false, ...(saved.settings || {}) }; } catch {}
if (process.env.HOST_KEY) D.hostKey = process.env.HOST_KEY;
if (!D.hostKey) D.hostKey = String(crypto.randomInt(1000, 9999));
if (D.phase === 'open') D.phase = 'results';
if (!Q[D.cur]) { D.cur = -1; if (D.phase !== 'end') D.phase = 'lobby'; }

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.writeFile(F_D, JSON.stringify(D), () => {});
  }, 300);
}

const qKey = i => i + ':' + (Q[i] ? Q[i].title : '');
const effType = q => (q.type === 'person' && !R.length ? 'short' : q.type);
function publicQ(i) {
  const q = Q[i]; if (!q) return null;
  const type = effType(q);
  return { title: q.title, type, options: type === 'choice' ? q.options : type === 'person' ? R : [] };
}
function timeFor(q) {
  if (q.time != null) return q.time;
  const t = effType(q);
  return (t === 'short' || t === 'long') ? D.settings.timeText : D.settings.timeChoice;
}
function normKey(s) {
  const k = s.replace(/\s+/g, '').toLowerCase().replace(/[.!?~]+$/, '').replace(/(교수님|교수|선생님|님)$/, '');
  return k || s;
}
function hashOf(s) { return crypto.createHash('md5').update(s).digest('hex'); }

function results(i) {
  const q = Q[i]; if (!q) return null;
  const t = effType(q);
  const vals = Object.values(D.answers[qKey(i)] || {});
  const r = { type: t, total: vals.length, items: [] };
  if (t === 'choice') {
    const c = new Map(q.options.map(o => [o, 0]));
    for (const v of vals) if (c.has(v)) c.set(v, c.get(v) + 1);
    r.items = [...c].map(([label, count]) => ({ label, count }));
    if (q.options.length > 8) { // 보기가 많으면 순위로
      r.ranked = true;
      r.items = r.items.filter(i => i.count > 0).sort((a, b) => b.count - a.count);
    }
  } else if (t === 'person') {
    const c = new Map();
    for (const v of vals) c.set(v, (c.get(v) || 0) + 1);
    r.items = [...c].map(([label, count]) => ({ label, count }))
      .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, 'ko'));
  } else if (t === 'number') {
    const nums = vals.map(Number);
    const c = new Map();
    for (const n of nums) c.set(n, (c.get(n) || 0) + 1);
    if (nums.length) {
      const min = Math.min(...nums), max = Math.max(...nums);
      if (max - min <= 20) for (let n = min; n <= max; n++) if (!c.has(n)) c.set(n, 0);
      r.avg = Math.round(nums.reduce((a, b) => a + b, 0) / nums.length * 10) / 10;
      r.min = min; r.max = max;
      let mode = null, mc = -1; for (const [n, k] of c) if (k > mc) { mc = k; mode = n; }
      r.mode = mode;
    }
    r.items = [...c].sort((a, b) => a[0] - b[0]).map(([n, count]) => ({ label: String(n), count }));
  } else if (t === 'short') {
    const g = new Map();
    for (const v of vals) {
      const k = normKey(v);
      if (!g.has(k)) g.set(k, { count: 0, variants: new Map() });
      const e = g.get(k); e.count++; e.variants.set(v, (e.variants.get(v) || 0) + 1);
    }
    r.items = [...g.values()].map(e => {
      let best = '', bc = -1; for (const [v, k] of e.variants) if (k > bc) { bc = k; best = v; }
      return { label: best, count: e.count };
    }).sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, 'ko'));
  } else {
    r.items = vals.map(label => ({ label, h: hashOf(label) }))
      .sort((a, b) => (a.h < b.h ? -1 : 1)).map(({ label }) => ({ label }));
  }
  return r;
}

// ---------- 실시간 연결 (Server-Sent Events) ----------
const clients = new Set();
const conn = {}; // cid -> 연결 수

function onlineCids() { return Object.keys(conn).filter(c => conn[c] > 0 && D.players[c]); }

function baseView() {
  const i = D.cur, q = Q[i];
  return {
    phase: D.phase, cur: i, total: Q.length, q: q ? publicQ(i) : null,
    endsAt: D.endsAt, now: Date.now(), online: onlineCids().length,
    answered: q ? Object.keys(D.answers[qKey(i)] || {}).length : 0,
    results: (D.phase === 'results' && q) ? results(i) : null,
  };
}
function lanUrls() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) out.push(`http://${a.address}:${PORT}`);
  }
  return out;
}
function hostView(base) {
  return {
    ...base,
    players: onlineCids().map(c => D.players[c]).sort((a, b) => a.localeCompare(b, 'ko')),
    questions: Q.map((q, i) => ({ title: q.title, type: effType(q), answered: Object.keys(D.answers[qKey(i)] || {}).length })),
    settings: D.settings, questionsText, rosterText, rosterCount: R.length, lanUrls: lanUrls(), publicUrl,
  };
}
function playerView(base, cid) {
  const q = Q[D.cur];
  const mine = q ? (D.answers[qKey(D.cur)] || {})[cid] : undefined;
  return { ...base, me: D.players[cid] || null, myAnswer: mine === undefined ? null : mine };
}
function send(c, base) {
  const v = c.role === 'host' ? hostView(base) : playerView(base, c.cid);
  c.res.write(`data: ${JSON.stringify(v)}\n\n`);
}
let bTimer = null;
function changed() {
  save();
  if (bTimer) return;
  bTimer = setTimeout(() => {
    bTimer = null;
    const base = baseView();
    for (const c of clients) { try { send(c, base); } catch {} }
  }, 80);
}
setInterval(() => { for (const c of clients) { try { c.res.write(': ping\n\n'); } catch {} } }, 15000);

function sse(req, res, u) {
  const role = u.searchParams.get('role') === 'host' ? 'host' : 'player';
  const cid = (u.searchParams.get('cid') || '').slice(0, 64);
  if (role === 'host' && u.searchParams.get('key') !== D.hostKey) { res.writeHead(403); return res.end(); }
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive', 'X-Accel-Buffering': 'no',
  });
  res.write('retry: 2000\n\n');
  const c = { res, role, cid };
  clients.add(c);
  if (role === 'player' && cid) conn[cid] = (conn[cid] || 0) + 1;
  send(c, baseView());
  changed();
  req.on('close', () => {
    clients.delete(c);
    if (role === 'player' && cid) { conn[cid]--; if (conn[cid] <= 0) delete conn[cid]; }
    changed(); checkAuto();
  });
}

// ---------- 인터넷 공개 주소 (node server.js --online) ----------
let publicUrl = process.env.PUBLIC_URL || '';
function startTunnel() {
  const { spawn } = require('child_process');
  console.log('  🌐 인터넷 주소를 만드는 중… (처음엔 30초~1분 걸릴 수 있어요)');
  const cmd = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  const p = spawn(cmd, ['-y', 'cloudflared', 'tunnel', '--no-autoupdate', '--url', `http://localhost:${PORT}`], { shell: process.platform === 'win32' });
  const watch = buf => {
    const m = String(buf).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    if (m && m[0] !== publicUrl) {
      publicUrl = m[0];
      console.log(`\n  ✅ 인터넷 참여 주소:  ${publicUrl}`);
      console.log('     (진행자 화면 QR에 자동으로 들어가요. 와이파이가 달라도, LTE/5G로도 접속 가능)\n');
      changed();
    }
  };
  p.stdout.on('data', watch); p.stderr.on('data', watch);
  p.on('error', e => console.log('  ⚠️ 인터넷 주소 만들기 실패:', e.message, '\n     README의 "방법 B"를 확인해 주세요.'));
  p.on('exit', code => { if (code) console.log(`  ⚠️ 인터넷 주소 연결이 끊겼어요 (코드 ${code}). 서버를 다시 켜 주세요.`); publicUrl = process.env.PUBLIC_URL || ''; changed(); });
  const kill = () => { try { p.kill(); } catch {} process.exit(0); };
  process.on('SIGINT', kill); process.on('SIGTERM', kill);
}

// ---------- 진행 ----------
let qTimer = null, autoTimer = null;
function clearTimers() { clearTimeout(qTimer); clearTimeout(autoTimer); qTimer = autoTimer = null; }
function schedule() {
  clearTimeout(qTimer); qTimer = null;
  if (D.phase === 'open' && D.endsAt) qTimer = setTimeout(closeQ, Math.max(0, D.endsAt - Date.now()));
}
function closeQ() {
  if (D.phase !== 'open') return;
  clearTimers(); D.phase = 'results'; D.endsAt = 0; changed();
}
function checkAuto() {
  if (!D.settings.autoClose || D.phase !== 'open' || autoTimer) return;
  const on = onlineCids(); const ans = D.answers[qKey(D.cur)] || {};
  if (on.length && on.every(c => c in ans)) {
    const cur = D.cur;
    autoTimer = setTimeout(() => {
      autoTimer = null;
      const on2 = onlineCids(); const ans2 = D.answers[qKey(D.cur)] || {};
      if (D.cur === cur && on2.length && on2.every(c => c in ans2)) closeQ();
    }, 1500);
  }
}

const str = (v, max) => (typeof v === 'string' ? v : v == null ? '' : String(v)).slice(0, max);
const clampInt = (v, lo, hi, d) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };

function hostAction(d) {
  switch (d.action) {
    case 'ping': return { ok: true };
    case 'start': {
      const i = Number(d.i); if (!Q[i]) throw new Error('없는 질문이에요');
      clearTimers(); D.cur = i; D.phase = 'open'; D.answers[qKey(i)] = {};
      const sec = timeFor(Q[i]); D.endsAt = sec > 0 ? Date.now() + sec * 1000 : 0; schedule();
      break;
    }
    case 'close': closeQ(); break;
    case 'extend': if (D.phase === 'open') { D.endsAt = Math.max(D.endsAt || 0, Date.now()) + 15000; schedule(); } break;
    case 'show': { const i = Number(d.i); if (!Q[i]) throw new Error('없는 질문이에요'); clearTimers(); D.cur = i; D.phase = 'results'; D.endsAt = 0; break; }
    case 'lobby': clearTimers(); D.phase = 'lobby'; D.endsAt = 0; break;
    case 'end': clearTimers(); D.phase = 'end'; D.endsAt = 0; break;
    case 'config': {
      if (typeof d.questionsText === 'string') {
        const nq = parseQuestions(d.questionsText);
        if (!nq.length) throw new Error('질문이 하나도 없어요. 형식을 확인해 주세요');
        questionsText = str(d.questionsText, 200000); Q = nq; fs.writeFile(F_Q, questionsText, () => {});
      }
      if (typeof d.rosterText === 'string') { rosterText = str(d.rosterText, 50000); R = parseRoster(rosterText); fs.writeFile(F_R, rosterText, () => {}); }
      if (d.settings) {
        D.settings.timeChoice = clampInt(d.settings.timeChoice, 0, 600, D.settings.timeChoice);
        D.settings.timeText = clampInt(d.settings.timeText, 0, 600, D.settings.timeText);
        D.settings.autoClose = !!d.settings.autoClose;
      }
      if (!Q[D.cur]) { clearTimers(); D.cur = -1; D.phase = 'lobby'; }
      break;
    }
    case 'resetAll': clearTimers(); D.answers = {}; D.cur = -1; D.phase = 'lobby'; D.endsAt = 0; if (d.players) D.players = {}; break;
    default: throw new Error('알 수 없는 동작');
  }
  changed();
  return { ok: true };
}

function api(p, d) {
  if (p === '/api/join') {
    const cid = str(d.cid, 64), name = str(d.name, 20).trim();
    if (!cid || !name) throw new Error('닉네임을 입력해 주세요');
    D.players[cid] = name; changed(); checkAuto();
    return { ok: true };
  }
  if (p === '/api/answer') {
    const cid = str(d.cid, 64);
    if (!D.players[cid]) throw new Error('먼저 입장해 주세요');
    if (D.phase !== 'open') throw new Error('지금은 답을 받지 않아요');
    const i = D.cur, q = Q[i], t = effType(q);
    let v = d.value;
    if (t === 'choice') { if (!q.options.includes(v)) throw new Error('보기에서 골라 주세요'); }
    else if (t === 'person') { if (!R.includes(v)) throw new Error('명단에서 골라 주세요'); }
    else if (t === 'number') { v = Number(v); if (!Number.isInteger(v) || v < 0 || v > 999) throw new Error('0~999 사이 숫자를 입력해 주세요'); }
    else {
      v = t === 'short' ? str(v, 30).replace(/\s+/g, ' ').trim() : str(v, 300).trim();
      if (!v) throw new Error('답을 입력해 주세요');
    }
    (D.answers[qKey(i)] ||= {})[cid] = v;
    changed(); checkAuto();
    return { ok: true };
  }
  if (p === '/api/host') {
    if (str(d.key, 100) !== D.hostKey) throw new Error('호스트 비밀번호가 틀렸어요');
    return hostAction(d);
  }
  throw new Error('알 수 없는 요청');
}

// ---------- HTTP ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (req.method === 'GET' && u.pathname === '/events') return sse(req, res, u);
  if (req.method === 'POST' && u.pathname.startsWith('/api/')) {
    let body = '';
    req.on('data', ch => { body += ch; if (body.length > 1e6) req.destroy(); });
    req.on('end', () => {
      let data = {}, out, code = 200;
      try { data = JSON.parse(body || '{}'); } catch {}
      try { out = api(u.pathname, data); } catch (e) { out = { error: e.message }; code = 400; }
      res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(out));
    });
    return;
  }
  let p = u.pathname === '/' ? '/play.html' : u.pathname === '/host' ? '/host.html' : u.pathname;
  const f = path.normalize(path.join(PUB, decodeURIComponent(p)));
  if (!f.startsWith(PUB + path.sep)) { res.writeHead(403); return res.end(); }
  fs.readFile(f, (err, buf) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('없는 페이지예요'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(buf);
  });
});

server.listen(PORT, () => {
  const lan = lanUrls();
  console.log('\n🎉 종강파티 투표 서버가 켜졌어요!\n');
  console.log(`  ▶ 진행자 화면 (이 컴퓨터에서 열기):  http://localhost:${PORT}/host?key=${D.hostKey}`);
  console.log(`  ▶ 호스트 비밀번호:  ${D.hostKey}`);
  if (lan.length) console.log(`  ▶ 같은 와이파이의 휴대폰 참여 주소:  ${lan.join('  또는  ')}`);
  console.log(`\n  질문 ${Q.length}개, 동기 명단 ${R.length}명 불러옴`);
  console.log('  끄려면 이 창에서 Ctrl + C\n');
  if (process.argv.includes('--open')) {
    const url = `http://localhost:${PORT}/host?key=${D.hostKey}`;
    const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
    try { require('child_process').spawn(opener, [url], { stdio: 'ignore', detached: true }).on('error', () => {}).unref(); } catch {}
  }
  if (process.argv.includes('--online')) startTunnel();
});
