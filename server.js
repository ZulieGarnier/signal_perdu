'use strict';
/* Signal perdu — jeu façon Gartic Phone où l'on génère des images avec l'IA.
   Serveur unique : HTTP statique + WebSocket + appel à l'API Gemini (clé côté serveur uniquement). */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.GEMINI_API_KEY || '';
const MODEL = process.env.GEMINI_IMAGE_MODEL || 'gemini-2.5-flash-image';
const MAX_PLAYERS = 16;
const MAX_ATTEMPTS = Number(process.env.MAX_ATTEMPTS || 1); // générations réussies par joueur et par tour (les échecs ne comptent pas)
const MAX_PARALLEL_GEN = Number(process.env.MAX_PARALLEL_GEN || 5);
const ROOM_TTL_MS = 6 * 3600 * 1000;

const rooms = new Map();
const hex = (n) => crypto.randomBytes(n).toString('hex');
const clamp = (v, lo, hi, d) => { v = Number(v); return Number.isFinite(v) ? Math.max(lo, Math.min(hi, Math.round(v))) : d; };
const clean = (s, max) => String(s == null ? '' : s).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, max);

function newCode() {
  const A = 'ABCDEFGHJKMNPQRSTUVWXYZ';
  let c;
  do { c = Array.from({ length: 4 }, () => A[crypto.randomInt(A.length)]).join(''); } while (rooms.has(c));
  return c;
}

/* ---------- règles du jeu ----------
   Joueur i, tour r  ->  album (i - r) mod n.
   Tour 0 : écrire son prompt de départ. Tours impairs : générer une image à partir du prompt reçu.
   Tours pairs > 0 : décrire l'image reçue par un prompt. */
const roundType = (r) => (r === 0 ? 'write' : r % 2 === 1 ? 'image' : 'describe');

function createRoom(host) {
  const room = {
    code: newCode(), hostId: host.id, phase: 'lobby', players: new Map([[host.id, host]]),
    order: [], albums: [], round: 0, rounds: 0, endsAt: 0, submitted: new Set(),
    settings: { rounds: 0, secWrite: 90, secImage: 120, secDescribe: 90, style: '', hostPlays: true },
    reveal: { album: 0, step: 0 }, images: new Map(), touched: Date.now(),
  };
  rooms.set(room.code, room);
  return room;
}

function activeIds(room) { return room.order.filter((id) => { const p = room.players.get(id); return p && p.connected; }); }

function taskFor(room, p) {
  if (room.phase !== 'play') return null;
  const i = room.order.indexOf(p.id);
  if (i < 0) return null;
  const n = room.order.length, r = room.round;
  const a = (((i - r) % n) + n) % n;
  const type = roundType(r);
  let recv = null;
  if (r > 0) {
    const prev = room.albums[a].steps[r - 1];
    if (prev) recv = { type: prev.type, text: prev.text || '', url: prev.imageId ? `/img/${room.code}/${prev.imageId}` : null, skipped: !!prev.skipped, constraint: prev.constraint || '' };
  }
  return {
    album: a, round: r, type, recv, done: room.submitted.has(p.id),
    myConstraint: (room.albums[a].steps[r] || {}).constraint || '', lastRound: r >= room.rounds - 1,
    candidates: (p.cands || []).map((id) => ({ id, url: `/img/${room.code}/${id}` })),
    attempts: p.attempts || 0, maxAttempts: MAX_ATTEMPTS, busy: !!p.gen, error: p.error || '',
  };
}

function albumsView(room) {
  return room.albums.map((al, i) => ({
    owner: (room.players.get(room.order[i]) || {}).name || 'Joueur',
    steps: al.steps.map((st) => st && ({
      round: st.round, type: st.type, skipped: !!st.skipped, text: st.text || '', constraint: st.constraint || '', extra: st.extra || '',
      author: (room.players.get(st.author) || {}).name || 'Joueur',
      url: st.imageId ? `/img/${room.code}/${st.imageId}` : null,
    })),
  }));
}

function viewFor(room, p) {
  const showAlbums = room.phase === 'reveal' || room.phase === 'gallery';
  return {
    t: 'state', room: room.code, me: p.id, host: room.hostId === p.id, phase: room.phase, settings: room.settings,
    players: [...room.players.values()].map((q) => ({
      id: q.id, name: q.name, connected: q.connected, host: q.id === room.hostId, bot: !!q.bot,
      playing: room.order.includes(q.id), done: room.phase === 'play' && room.submitted.has(q.id),
    })),
    order: room.order, round: room.round, rounds: room.rounds, roundType: room.phase === 'play' ? roundType(room.round) : null,
    endsAt: room.endsAt, now: Date.now(), task: taskFor(room, p), reveal: room.reveal,
    albums: showAlbums ? albumsView(room) : null, mock: !API_KEY,
  };
}

function send(p, msg) { if (p.ws && p.ws.readyState === 1) p.ws.send(JSON.stringify(msg)); }
function broadcast(room) { room.touched = Date.now(); for (const p of room.players.values()) send(p, viewFor(room, p)); }

/* ---------- déroulement ---------- */
function secondsFor(room, type) {
  const s = room.settings;
  return type === 'write' ? s.secWrite : type === 'image' ? s.secImage : s.secDescribe;
}
function startRound(room) {
  room.submitted = new Set();
  for (const id of room.order) { const p = room.players.get(id); if (p) { p.cands = []; p.attempts = 0; p.gen = false; p.error = ''; p.extra = ''; } }
  room.endsAt = Date.now() + secondsFor(room, roundType(room.round)) * 1000;
  broadcast(room);
  botsPlay(room);
}
function record(room, p, step) {
  const t = taskFor(room, p);
  if (!t || t.done) return;
  room.albums[t.album].steps[t.round] = Object.assign({ round: t.round, author: p.id }, step);
  room.submitted.add(p.id);
}
function finishRound(room) {
  for (const id of room.order) {
    if (room.submitted.has(id)) continue;
    const p = room.players.get(id), t = p && taskFor(room, p);
    if (!t) continue;
    if (t.type === 'image') {
      const last = (p.cands || []).slice(-1)[0];
      record(room, p, { type: 'image', imageId: last || null, skipped: !last, extra: last ? (p.extra || '') : '' });
    } else {
      record(room, p, { type: 'prompt', text: '', skipped: true });
    }
  }
  if (room.round + 1 >= room.rounds) { room.phase = 'reveal'; room.reveal = { album: 0, step: 0 }; room.endsAt = 0; broadcast(room); }
  else { room.round += 1; startRound(room); }
}
function maybeAdvance(room) {
  if (room.phase !== 'play') return;
  const waiting = room.order.filter((id) => { const p = room.players.get(id); return p && p.connected && !room.submitted.has(id); });
  if (waiting.length === 0) finishRound(room); else broadcast(room);
}

/* ---------- joueurs de test (bots) : jouent automatiquement, images factices sans coût ---------- */
const BOT_TEXTS = ['Un phare au bord d’une falaise, ciel orageux', 'Une table dressée dans une forêt de brume', 'Un robot qui arrose des tournesols', 'Une ruelle pavée sous la pluie, néons rouges', 'Un chat qui dirige un orchestre'];
function botsPlay(room) {
  const r = room.round;
  room.order.forEach((id) => {
    const p = room.players.get(id);
    if (!p || !p.bot) return;
    setTimeout(() => {
      if (room.phase !== 'play' || room.round !== r || room.submitted.has(id)) return;
      const t = taskFor(room, p); if (!t || t.done) return;
      if (t.type === 'image') {
        const prompt = (t.recv && t.recv.text) || 'image de test';
        const iid = hex(8); room.images.set(iid, mockImage(prompt)); record(room, p, { type: 'image', imageId: iid });
      } else {
        const text = t.type === 'write' ? BOT_TEXTS[crypto.randomInt(BOT_TEXTS.length)] : 'Description de test : ' + BOT_TEXTS[crypto.randomInt(BOT_TEXTS.length)].toLowerCase();
        record(room, p, { type: 'prompt', text });
      }
      maybeAdvance(room);
    }, 1000 + crypto.randomInt(3000));
  });
}

/* ---------- génération d'image (Gemini) ---------- */
let running = 0; const queue = [];
function limited(fn) {
  return new Promise((resolve, reject) => {
    const run = () => { running++; fn().then(resolve, reject).finally(() => { running--; const nx = queue.shift(); if (nx) nx(); }); };
    if (running < MAX_PARALLEL_GEN) run(); else queue.push(run);
  });
}
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function mockImage(prompt) {
  const words = prompt.split(/\s+/).reduce((acc, w) => { const l = acc[acc.length - 1]; if ((l + ' ' + w).length > 34) acc.push(w); else acc[acc.length - 1] = (l + ' ' + w).trim(); return acc; }, ['']).slice(0, 8);
  const hue = crypto.randomInt(360);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 600"><rect width="600" height="600" fill="hsl(${hue},60%,88%)"/><circle cx="470" cy="130" r="70" fill="hsl(${(hue + 40) % 360},70%,70%)"/><text x="40" y="60" font-family="Arial" font-size="20" fill="#E3001B" font-weight="bold">IMAGE DE TEST (pas de clé API)</text>${words.map((w, i) => `<text x="40" y="${240 + i * 34}" font-family="Arial" font-size="26" fill="#202020">${esc(w)}</text>`).join('')}</svg>`;
  return { buf: Buffer.from(svg), type: 'image/svg+xml' };
}
async function makeImage(prompt) {
  if (!API_KEY) { await new Promise((r) => setTimeout(r, 1200)); return mockImage(prompt); }
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': API_KEY },
        body: JSON.stringify({ contents: [{ parts: [{ text: (attempt === 0 ? 'Génère une image (réponds uniquement par une image, sans texte) : ' : 'Create an image, output only the image: ') + prompt }] }], generationConfig: { responseModalities: ['IMAGE'] } }),
      });
      if (res.status === 429 || res.status >= 500) { const body = await res.json().catch(() => ({})); lastErr = new Error('busy ' + res.status + ' ' + ((body.error && body.error.message) || '').slice(0, 400)); if (res.status === 429 && /limit: 0|billing|plan/i.test(lastErr.message)) break; await new Promise((r) => setTimeout(r, 1500 * (attempt + 1))); continue; }
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((data.error && data.error.message) || ('HTTP ' + res.status));
      const parts = (((data.candidates || [])[0] || {}).content || {}).parts || [];
      const part = parts.find((x) => (x.inlineData || x.inline_data));
      if (!part) {
        const cand = (data.candidates || [])[0] || {};
        console.error('no image returned:', JSON.stringify({ finish: cand.finishReason, block: data.promptFeedback && data.promptFeedback.blockReason, text: parts.map((x) => x.text).filter(Boolean).join(' ').slice(0, 300) }));
        lastErr = new Error('refused'); continue;
      }
      const inl = part.inlineData || part.inline_data;
      return { buf: Buffer.from(inl.data, 'base64'), type: inl.mimeType || inl.mime_type || 'image/png' };
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('fail');
}
async function generate(room, p, extraPrompt, extra) {
  const t = taskFor(room, p);
  if (!t || t.type !== 'image' || t.done || p.gen || p.attempts >= MAX_ATTEMPTS) return;
  let prompt = t.recv && !t.recv.skipped && t.recv.text ? t.recv.text : clean(extraPrompt, 700);
  if (!prompt) { p.error = 'Aucun prompt reçu : écris le tien.'; return send(p, viewFor(room, p)); }
  if (t.recv && t.recv.constraint) prompt += '. Élément obligatoire à intégrer : ' + t.recv.constraint;
  extra = clean(extra, 80);
  if (extra) prompt += '. Élément ajouté par le joueur : ' + extra;
  if (room.settings.style) prompt += '. ' + room.settings.style;
  const r = room.round;
  p.gen = true; p.error = '';
  broadcastOne(room, p);
  try {
    const img = await limited(() => makeImage(prompt));
    if (room.round === r && room.phase === 'play' && !room.submitted.has(p.id)) {
      const id = hex(8); room.images.set(id, img); p.cands.push(id); p.attempts += 1; p.extra = extra;
    }
  } catch (e) {
    p.error = e.message === 'refused' ? 'L’IA a refusé ce prompt. Essaie à nouveau.' : /busy 429/.test(e.message) ? 'Le quota de génération Google est atteint. Réessaie dans une minute.' : 'La génération a échoué. Réessaie dans un instant.';
    console.error('gen error:', e.message);
  } finally { p.gen = false; broadcastOne(room, p); }
}
function broadcastOne(room, p) { send(p, viewFor(room, p)); }

/* ---------- messages ---------- */
function handle(ws, ctx, msg) {
  const room = ctx.room, p = ctx.player;
  switch (msg.t) {
    case 'create': case 'join': {
      if (ctx.player) return;
      const name = clean(msg.name, 24);
      const token = clean(msg.token, 64);
      if (!name || token.length < 16) return send({ ws }, { t: 'error', m: 'Pseudo manquant.' });
      let rm;
      if (msg.t === 'create') {
        const host = { id: hex(6), token, name, connected: true, ws, cands: [], attempts: 0 };
        rm = createRoom(host); ctx.room = rm; ctx.player = host;
      } else {
        rm = rooms.get(clean(msg.room, 8).toUpperCase());
        if (!rm) return send({ ws }, { t: 'error', m: 'Cette salle n’existe pas (ou plus).' });
        let pl = [...rm.players.values()].find((q) => q.token === token);
        if (pl) { pl.ws = ws; pl.connected = true; if (name) pl.name = name; }
        else {
          if (rm.phase !== 'lobby') return send({ ws }, { t: 'error', m: 'La partie a déjà commencé. Tu pourras jouer à la prochaine.' });
          if (rm.players.size >= MAX_PLAYERS) return send({ ws }, { t: 'error', m: 'La salle est pleine.' });
          pl = { id: hex(6), token, name, connected: true, ws, cands: [], attempts: 0 };
          rm.players.set(pl.id, pl);
        }
        ctx.room = rm; ctx.player = pl;
      }
      return broadcast(ctx.room);
    }
    default: break;
  }
  if (!room || !p) return;
  const isHost = room.hostId === p.id;
  switch (msg.t) {
    case 'rename': { const n = clean(msg.name, 24); if (n && room.phase === 'lobby') { p.name = n; broadcast(room); } break; }
    case 'addbot': {
      if (!isHost || room.phase !== 'lobby' || room.players.size >= MAX_PLAYERS) break;
      const k = [...room.players.values()].filter((q) => q.bot).length + 1;
      const id = hex(6);
      room.players.set(id, { id, token: hex(16), name: 'Test ' + k, connected: true, ws: null, bot: true, cands: [], attempts: 0 });
      broadcast(room); break;
    }
    case 'kick': { if (isHost && room.phase === 'lobby' && msg.id !== p.id) { const q = room.players.get(msg.id); if (q) { send(q, { t: 'kicked' }); room.players.delete(msg.id); broadcast(room); } } break; }
    case 'start': {
      if (!isHost || room.phase !== 'lobby') break;
      const s = msg.settings || {};
      room.settings = {
        rounds: clamp(s.rounds, 2, MAX_PLAYERS, 0), secWrite: clamp(s.secWrite, 20, 600, 90), secImage: clamp(s.secImage, 30, 600, 120),
        secDescribe: clamp(s.secDescribe, 20, 600, 90), style: clean(s.style, 200), hostPlays: s.hostPlays !== false,
      };
      room.order = [...room.players.values()].filter((q) => q.connected && (room.settings.hostPlays || q.id !== room.hostId)).map((q) => q.id);
      const n = room.order.length;
      if (n < 2) { send(p, { t: 'error', m: 'Il faut au moins 2 joueurs connectés.' }); break; }
      room.rounds = Math.max(2, Math.min(room.settings.rounds || n, n));
      room.albums = room.order.map(() => ({ steps: [] }));
      room.images = new Map(); room.round = 0; room.phase = 'play';
      startRound(room); break;
    }
    case 'submit': {
      if (room.phase !== 'play') break;
      const t = taskFor(room, p); if (!t || t.done) break;
      if (t.type === 'image') {
        const id = (p.cands || []).includes(msg.imageId) ? msg.imageId : (p.cands || []).slice(-1)[0];
        record(room, p, { type: 'image', imageId: id || null, skipped: !id, extra: id ? (p.extra || '') : '' });
      } else {
        const text = clean(msg.text, 700);
        record(room, p, { type: 'prompt', text, skipped: !text });
      }
      maybeAdvance(room); break;
    }
    case 'constraint': {
      if (room.phase !== 'play') break;
      const t = taskFor(room, p); if (!t || !t.done || t.lastRound) break;
      const st = room.albums[t.album].steps[t.round]; if (!st) break;
      st.constraint = clean(msg.text, 80); send(p, viewFor(room, p)); break;
    }
    case 'generate': generate(room, p, msg.prompt, msg.extra); break;
    case 'reveal': {
      if (!isHost) break;
      if (msg.a === 'next' && room.phase === 'reveal') {
        const al = room.albums[room.reveal.album];
        if (room.reveal.step < al.steps.length - 1) room.reveal.step += 1;
        else if (room.reveal.album < room.albums.length - 1) room.reveal = { album: room.reveal.album + 1, step: 0 };
        else room.phase = 'gallery';
      } else if (msg.a === 'prev' && room.phase === 'reveal') {
        if (room.reveal.step > 0) room.reveal.step -= 1;
        else if (room.reveal.album > 0) room.reveal = { album: room.reveal.album - 1, step: room.albums[room.reveal.album - 1].steps.length - 1 };
      } else if (msg.a === 'gallery') room.phase = 'gallery';
      broadcast(room); break;
    }
    case 'again': { if (isHost && (room.phase === 'gallery' || room.phase === 'reveal')) { room.phase = 'lobby'; room.albums = []; room.order = []; room.images = new Map(); room.endsAt = 0; broadcast(room); } break; }
    default: break;
  }
}

/* ---------- serveur HTTP ---------- */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
const PUB = path.join(__dirname, 'public');
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/health') { res.end('ok'); return; }
  const m = u.pathname.match(/^\/img\/([A-Z]{4})\/([0-9a-f]{16})$/);
  if (m) {
    const rm = rooms.get(m[1]); const img = rm && rm.images.get(m[2]);
    if (!img) { res.statusCode = 404; res.end(); return; }
    res.writeHead(200, { 'Content-Type': img.type, 'Cache-Control': 'private, max-age=86400', 'X-Content-Type-Options': 'nosniff' });
    res.end(img.buf); return;
  }
  let f = u.pathname === '/' ? '/index.html' : u.pathname;
  const full = path.normalize(path.join(PUB, f));
  if (!full.startsWith(PUB) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) { res.statusCode = 404; res.end('Not found'); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff' });
  fs.createReadStream(full).pipe(res);
});
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 16 * 1024 });
wss.on('connection', (ws) => {
  const ctx = { room: null, player: null };
  ws.isAlive = true; ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', (raw) => { let msg; try { msg = JSON.parse(raw); } catch (e) { return; } try { handle(ws, ctx, msg); } catch (e) { console.error(e); } });
  ws.on('close', () => { const { room, player } = ctx; if (room && player && player.ws === ws) { player.connected = false; player.ws = null; maybeAdvance(room); if (room.phase !== 'play') broadcast(room); } });
});
setInterval(() => { wss.clients.forEach((ws) => { if (!ws.isAlive) return ws.terminate(); ws.isAlive = false; ws.ping(); }); }, 25000);
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (room.phase === 'play' && room.endsAt && now > room.endsAt + 4000) finishRound(room);
    if (now - room.touched > ROOM_TTL_MS) rooms.delete(code);
  }
}, 500);
server.listen(PORT, () => console.log(`Signal perdu sur le port ${PORT} — ${API_KEY ? 'Gemini ' + MODEL : 'MODE TEST (pas de clé API)'}`));
