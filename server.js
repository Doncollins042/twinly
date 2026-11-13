// Twinly — server: dashboard + API + WhatsApp bridge
import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { Store, deepMerge } from './lib/store.js';
import { parseUpload, guessOwner } from './lib/parser.js';
import { buildProfile } from './lib/analyzer.js';
import { WhatsApp } from './lib/whatsapp.js';
import { Engine } from './lib/engine.js';
import { generateReply, buildSystemPrompt } from './lib/persona.js';
import { PROVIDERS, complete } from './lib/llm.js';
import QRCode from 'qrcode';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const PORT = Number(process.env.PORT || 4747);
const HOST = process.env.HOST || '127.0.0.1';
const PASSWORD = process.env.DASHBOARD_PASSWORD || '';

if (!PASSWORD && !['127.0.0.1', 'localhost', '::1'].includes(HOST)) {
  console.error('\n  ✖ HOST is public but DASHBOARD_PASSWORD is empty. Set a password in .env — your chats would be exposed.\n');
  process.exit(1);
}

const store = new Store(DATA_DIR);
// .env keys seed the settings on first run
if (process.env.AI_API_KEY && !store.state.settings.llm.apiKey) {
  store.state.settings.llm.apiKey = process.env.AI_API_KEY;
  store.state.settings.llm.provider = process.env.AI_PROVIDER || store.state.settings.llm.provider;
  store.state.settings.llm.model = process.env.AI_MODEL || store.state.settings.llm.model;
  store.flush();
}
const wa = new WhatsApp(path.join(DATA_DIR, 'wa-session'));
const engine = new Engine(store, wa);

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));

// ---- password: never on this computer, a friendly sign-in page everywhere else ----
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const authToken = PASSWORD ? crypto.createHmac('sha256', PASSWORD).update('twinly-session-v1').digest('hex') : '';
const cookieOf = req => Object.fromEntries(String(req.headers.cookie || '').split(';').map(c => c.trim().split('=')).filter(x => x[0]).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]));
const sameSecret = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
const isLocal = req => LOOPBACK.has(req.socket.remoteAddress) && !req.headers['x-forwarded-for'];

app.post('/login', express.urlencoded({ extended: false }), (req, res) => {
  if (PASSWORD && sameSecret(String(req.body?.password || ''), PASSWORD)) {
    res.set('Set-Cookie', `twinly_auth=${authToken}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 365}`);
    return res.redirect('/');
  }
  res.redirect('/login?wrong=1');
});
app.get('/logout', (req, res) => { res.set('Set-Cookie', 'twinly_auth=; Path=/; Max-Age=0'); res.redirect('/login'); });
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));

if (PASSWORD) {
  app.use((req, res, next) => {
    if (isLocal(req)) return next();
    if (sameSecret(cookieOf(req).twinly_auth || '', authToken)) return next();
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Please sign in again' });
    res.redirect('/login');
  });
}

app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

// ---- live events (SSE) ----
const clients = new Set();
function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(msg);
}
app.get('/api/events', (req, res) => {
  res.set({ 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' });
  res.flushHeaders();
  res.write(`event: wa\ndata: ${JSON.stringify(wa.snapshot())}\n\n`);
  clients.add(res);
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => { clearInterval(ping); clients.delete(res); });
});
let lastWa = '';
wa.on('status', s => {
  broadcast('wa', s);
  if (s.status === lastWa) return;
  lastWa = s.status;
  if (s.status === 'open') store.log('wa', `WhatsApp connected${s.me?.phone ? ` as +${s.me.phone}` : ''}`);
  if (s.status === 'error') { store.log('error', `WhatsApp: ${s.error?.title}`); console.log(`\n  ✖ WhatsApp: ${s.error?.title} — ${s.error?.hint}\n`); }
});
wa.on('error', e => store.log('error', e.message));
engine.on('log', e => broadcast('log', e));
engine.on('changed', what => broadcast('changed', { what }));
engine.on('live', l => broadcast('live', { jid: l.jid }));

// ---- helpers ----
const mask = k => (k ? `${k.slice(0, 6)}••••${k.slice(-4)}` : '');
const wrap = fn => (req, res) => Promise.resolve(fn(req, res)).catch(e => res.status(400).json({ error: e.message }));

function profileSummary() {
  const p = store.profile;
  if (!p) return null;
  const { pairs, ...rest } = p;
  return rest;
}

function contactsView() {
  const out = (store.profile?.contacts || []).map(c => ({ ...c, ...(store.state.contacts[c.id] || {}) }));
  const linked = {};
  for (const l of Object.values(store.state.live)) if (l.contactId) (linked[l.contactId] ||= []).push({ jid: l.jid, name: l.name, phone: l.phone });
  for (const c of out) c.linked = linked[c.id] || [];
  return out;
}

function liveView() {
  return Object.values(store.state.live)
    .sort((a, b) => (b.lastTs || 0) - (a.lastTs || 0))
    .slice(0, 200)
    .map(l => ({ ...l, history: l.history.slice(-8), override: store.state.contacts[`jid:${l.jid}`] || null }));
}

function lanUrls() {
  if (['127.0.0.1', 'localhost', '::1'].includes(HOST)) return [];
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) for (const n of list || []) {
    if (n.family === 'IPv4' && !n.internal && !/^169\.254\./.test(n.address)) out.push(`http://${n.address}:${PORT}`);
  }
  return out;
}

app.get('/api/state', (req, res) => {
  const s = structuredClone(store.state.settings);
  s.llm.apiKey = mask(s.llm.apiKey);
  res.json({
    settings: s,
    hasKey: !!store.state.settings.llm.apiKey,
    providers: PROVIDERS,
    profile: profileSummary(),
    chats: store.listChats(),
    contacts: contactsView(),
    live: liveView(),
    queue: store.state.queue.slice().reverse().slice(0, 120),
    plans: engine.plansView(),
    human: { cps: engine.cps(), sleep: engine.sleepRange(), learnedCps: store.profile?.overall?.typingCps || null, learnedSleep: store.profile?.overall?.sleep || null },
    log: store.state.log.slice(-120).reverse(),
    totals: store.state.totals,
    wa: wa.snapshot(),
    hasSession: wa.hasSession(),
    access: { lan: lanUrls(), password: !!PASSWORD },
  });
});

// ---- import & analyze ----
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 300 * 1024 * 1024, files: 200 } });
app.post('/api/import', upload.array('files'), wrap(async (req, res) => {
  const imported = [], failed = [];
  for (const f of req.files || []) {
    try {
      const chats = parseUpload(f.buffer, Buffer.from(f.originalname, 'latin1').toString('utf8'));
      if (!chats.length) failed.push({ file: f.originalname, error: 'No messages found — is this a WhatsApp/Telegram export?' });
      for (const c of chats) { store.saveChat(c); imported.push({ id: c.id, title: c.title, messageCount: c.messageCount, participants: c.participants }); }
    } catch (e) { failed.push({ file: f.originalname, error: e.message }); }
  }
  const all = store.listChats();
  res.json({ imported, failed, ownerCandidates: guessOwner(all), chats: all });
}));

app.delete('/api/chats/:id', wrap((req, res) => { store.deleteChat(req.params.id); res.json({ ok: true, chats: store.listChats() }); }));

app.post('/api/analyze', wrap((req, res) => {
  const owner = [].concat(req.body.owner || []).filter(Boolean);
  if (!owner.length) throw new Error('Pick which name is you');
  const chats = store.listChats({ withMessages: true });
  if (!chats.length) throw new Error('Import at least one chat export first');
  const profile = buildProfile(chats, owner);
  if (!profile.overall.textMessages) throw new Error(`No messages from "${owner.join(', ')}" were found in these exports`);
  store.saveProfile(profile);
  if (!store.state.settings.ownerDisplayName) store.state.settings.ownerDisplayName = owner[0];
  engine.reloadProfile();
  store.log('train', `Style DNA built from ${profile.overall.textMessages.toLocaleString()} of your messages across ${profile.contacts.length} chats`);
  store.flush();
  broadcast('changed', { what: 'profile' });
  res.json({ ok: true, profile: profileSummary() });
}));

// ---- settings & contacts ----
app.put('/api/settings', wrap((req, res) => {
  const body = structuredClone(req.body || {});
  if (body.llm && (body.llm.apiKey === undefined || body.llm.apiKey.includes('••••'))) delete body.llm.apiKey;
  const allowed = new Set(Object.keys(store.state.settings));
  for (const k of Object.keys(body)) if (!allowed.has(k)) delete body[k];
  if (body.escalateTopics) store.state.settings.escalateTopics = [];
  deepMerge(store.state.settings, body);
  store.flush();
  broadcast('changed', { what: 'settings' });
  res.json({ ok: true });
}));

app.put('/api/contacts/:id', wrap((req, res) => {
  const pick = ({ enabled, relationship, nickname, notes, displayName }) => ({ enabled, relationship, nickname, notes, displayName });
  const cur = store.state.contacts[req.params.id] || {};
  store.state.contacts[req.params.id] = Object.fromEntries(Object.entries({ ...cur, ...pick(req.body || {}) }).filter(([, v]) => v !== undefined));
  store.flush();
  broadcast('changed', { what: 'contacts' });
  res.json({ ok: true });
}));

app.put('/api/live/:jid/link', wrap((req, res) => {
  const l = store.state.live[req.params.jid];
  if (!l) throw new Error('Unknown chat');
  l.contactId = req.body.contactId || null;
  store.flush();
  broadcast('changed', { what: 'live' });
  res.json({ ok: true });
}));

// ---- playground ----
app.post('/api/test', wrap(async (req, res) => {
  const { contactId, messages = [], history = [] } = req.body || {};
  const incoming = [].concat(messages).map(String).filter(s => s.trim());
  if (!incoming.length) throw new Error('Type a message to test with');
  const contact = engine.contact(contactId);
  const t0 = Date.now();
  const out = await generateReply({ profile: store.profile, retriever: engine.retriever, contact, history, incoming, settings: store.state.settings, llm: store.state.settings.llm });
  res.json({ ...out, ms: Date.now() - t0 });
}));

app.get('/api/prompt', wrap((req, res) => {
  res.type('text/plain').send(buildSystemPrompt({ profile: store.profile, contact: engine.contact(req.query.contactId), settings: store.state.settings }));
}));

app.post('/api/test-llm', wrap(async (req, res) => {
  const t0 = Date.now();
  const text = await complete(store.state.settings.llm, 'Reply with the single word: ok', 'ping', { maxTokens: 10, temperature: 0 });
  res.json({ ok: true, reply: text.trim().slice(0, 40), ms: Date.now() - t0 });
}));

// ---- approvals ----
app.post('/api/queue/:id/approve', wrap(async (req, res) => { await engine.approve(req.params.id, req.body?.messages); res.json({ ok: true }); }));
app.post('/api/queue/:id/reject', wrap((req, res) => { engine.reject(req.params.id); res.json({ ok: true }); }));

// ---- whatsapp ----
app.post('/api/wa/connect', wrap(async (req, res) => { await wa.link({ phone: req.body?.phone || undefined }); res.json(wa.snapshot()); }));
app.post('/api/wa/reconnect', wrap(async (req, res) => { await wa.start(); res.json(wa.snapshot()); }));
app.post('/api/wa/disconnect', wrap(async (req, res) => { await wa.stop(); res.json(wa.snapshot()); }));
app.post('/api/wa/logout', wrap(async (req, res) => { await wa.logout(); store.log('wa', 'WhatsApp unlinked'); res.json(wa.snapshot()); }));

app.post('/api/plans/:jid/now', wrap((req, res) => { engine.rush(req.params.jid); res.json({ ok: true }); }));
app.post('/api/plans/:jid/cancel', wrap((req, res) => { engine.cancel(req.params.jid, 'cancelled from dashboard'); res.json({ ok: true }); }));

// test hook: simulate an incoming WhatsApp message (only when TWINLY_DEV=1)
if (process.env.TWINLY_DEV === '1') {
  app.post('/api/dev/incoming', wrap((req, res) => {
    const { jid = '2348000000000@s.whatsapp.net', name = 'Test', savedName, text = 'hi' } = req.body || {};
    wa.emit('message', { jid, isGroup: false, self: false, phone: jid.split('@')[0], name, savedName, fromMe: false, byTwinly: false, key: { id: crypto.randomUUID(), remoteJid: jid }, ts: Date.now(), kind: 'text', text });
    res.json({ ok: true });
  }));
  app.post('/api/dev/wa', wrap(async (req, res) => {
    const b = req.body || {};
    if (b.qrText) b.qr = await QRCode.toDataURL(b.qrText, { margin: 1, width: 420 });
    if (b.qrExpiresIn) b.qrExpiresAt = Date.now() + b.qrExpiresIn;
    delete b.qrText; delete b.qrExpiresIn;
    Object.assign(wa, b); wa.emit('status', wa.snapshot()); res.json(wa.snapshot());
  }));
}

app.get('/api/qr', wrap(async (req, res) => {
  res.type('text/plain').send(await QRCode.toDataURL(String(req.query.text || '').slice(0, 300), { margin: 1, width: 300 }));
}));

app.post('/api/wipe', wrap((req, res) => { store.wipe(); engine.reloadProfile(); broadcast('changed', { what: 'all' }); res.json({ ok: true }); }));

app.listen(PORT, HOST, () => {
  const url = `http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`;
  console.log(`\n  ✦ Twinly is running → ${url}${PASSWORD ? '  (password protected)' : ''}\n`);
  if (wa.hasSession()) wa.start().catch(e => console.error('WhatsApp start failed:', e.message));
});

// keep running through stray library errors instead of dropping WhatsApp
process.on('unhandledRejection', e => console.error('  ! background error:', e?.message || e));
process.on('uncaughtException', e => console.error('  ! unexpected error:', e?.message || e));

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { store.flush(); process.exit(0); });
