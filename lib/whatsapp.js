// Twinly — WhatsApp bridge (linked device via Baileys)
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import pino from 'pino';
import QRCode from 'qrcode';
import makeWASocket, {
  Browsers, DisconnectReason, fetchLatestBaileysVersion, isJidBroadcast, isJidGroup, isJidNewsletter,
  jidDecode, jidNormalizedUser, makeCacheableSignalKeyStore, useMultiFileAuthState,
} from '@whiskeysockets/baileys';

const logger = pino({ level: process.env.BAILEYS_LOG || 'silent' });
const sleep = ms => new Promise(r => setTimeout(r, ms));

function unwrap(message) {
  let m = message;
  for (let i = 0; i < 4 && m; i++) {
    const inner = m.ephemeralMessage?.message || m.viewOnceMessage?.message || m.viewOnceMessageV2?.message
      || m.documentWithCaptionMessage?.message || m.editedMessage?.message;
    if (!inner) break;
    m = inner;
  }
  return m;
}

export function extractContent(message) {
  const m = unwrap(message);
  if (!m) return null;
  if (m.protocolMessage || m.reactionMessage || m.senderKeyDistributionMessage && Object.keys(m).length === 1) return null;
  const text = m.conversation || m.extendedTextMessage?.text || m.imageMessage?.caption || m.videoMessage?.caption || m.documentMessage?.caption;
  if (m.audioMessage) return { kind: 'voice', text: '[sent a voice note]' };
  if (m.imageMessage) return { kind: 'image', text: text ? `[sent a photo] ${text}` : '[sent a photo]' };
  if (m.videoMessage) return { kind: 'video', text: text ? `[sent a video] ${text}` : '[sent a video]' };
  if (m.stickerMessage) return { kind: 'sticker', text: '[sent a sticker]' };
  if (m.documentMessage) return { kind: 'document', text: `[sent a file${m.documentMessage.fileName ? `: ${m.documentMessage.fileName}` : ''}]` };
  if (m.contactMessage || m.contactsArrayMessage) return { kind: 'contact', text: '[shared a contact]' };
  if (m.locationMessage || m.liveLocationMessage) return { kind: 'location', text: '[shared a location]' };
  if (text) return { kind: 'text', text };
  return null;
}

/** Turn whatever the user typed (0803…, +234 803…, 234803…) into international digits */
export function normalizePhone(input, defaultCc = '234') {
  let d = String(input || '').replace(/[^\d+]/g, '');
  if (d.startsWith('+')) d = d.slice(1);
  else if (d.startsWith('00')) d = d.slice(2);
  else if (d.startsWith('0')) d = defaultCc + d.slice(1);
  else if (d.length === 10 && defaultCc === '234' && /^[789]/.test(d)) d = defaultCc + d;
  d = d.replace(/\D/g, '');
  return d.length >= 10 && d.length <= 15 ? d : null;
}

// Plain-English explanations for WhatsApp disconnect codes
const ERRORS = {
  qr_expired: { title: 'The code expired', hint: 'WhatsApp codes only last a couple of minutes. Tap “Try again” for a fresh one and link it straight away.' },
  network: { title: 'Can’t reach WhatsApp', hint: 'Check this computer’s internet. Turn off any VPN or proxy, and allow Node.js through Windows Firewall if it asks.' },
  refused: { title: 'WhatsApp didn’t accept the link', hint: 'On your phone, open WhatsApp → Linked devices, remove any half-linked “Desktop” entry, then tap “Try again”. Make sure the phone has internet.' },
  logged_out: { title: 'Unlinked from your phone', hint: 'Twinly was removed under Linked devices on your phone. Link it again to keep auto-replying.' },
  banned: { title: 'WhatsApp blocked this connection (403)', hint: 'This number may be restricted. Open WhatsApp on your phone to see any notice from WhatsApp.' },
  replaced: { title: 'Twinly is open somewhere else', hint: 'Another copy of Twinly (or another tool) is using this session. Close it, then tap “Reconnect”.' },
  bad_session: { title: 'The saved session was damaged', hint: 'It has been cleared. Tap “Try again” to link fresh.' },
  outdated: { title: 'WhatsApp rejected the connection (405)', hint: 'Make sure this computer’s date and time are correct, then try again. If it keeps happening, update Twinly.' },
  too_many_devices: { title: 'Too many linked devices', hint: 'WhatsApp allows 4 linked devices. Remove one under Linked devices on your phone, then try again.' },
};

const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);

export class WhatsApp extends EventEmitter {
  constructor(authDir, { makeSocket, fetchVersion = true, watchdogMs = 35000 } = {}) {
    super();
    this.authDir = authDir;
    this.makeSocket = makeSocket || makeWASocket;
    this.fetchVersion = fetchVersion;
    this.watchdogMs = watchdogMs;
    this.sock = null;
    this.gen = 0;
    // idle | starting | qr | code | pairing | open | reconnecting | error
    this.status = 'idle';
    this.qr = null; this.qrRaw = null; this.qrExpiresAt = null;
    this.pairingCode = null; this.pairPhone = null;
    this.error = null;
    this.me = null;
    this.qrCycles = 0;
    this.retries = 0;
    this.sentIds = new Set();
    this.sendingTo = new Set();   // chats Twinly is typing into right now
    this.msgCache = new Map();
    this.contacts = new Map();    // jid → saved name from your address book
    this.subscribed = new Set();
    this.wantRunning = false;
    this.watchdog = null;
  }

  /** a finished link has creds.me — a half-finished one doesn't */
  hasSession() {
    try { const c = JSON.parse(fs.readFileSync(`${this.authDir}/creds.json`, 'utf8')); return !!(c?.me?.id && c?.account); } catch { return false; }
  }

  #set(status, extra = {}) {
    this.status = status;
    Object.assign(this, extra);
    this.emit('status', this.snapshot());
  }

  snapshot() {
    return {
      status: this.status, qr: this.qr, qrExpiresAt: this.qrExpiresAt, pairingCode: this.pairingCode,
      pairPhone: this.pairPhone, me: this.me, error: this.error, linked: this.status === 'open' || this.hasSession(),
    };
  }

  #fail(kind, extra = {}) {
    clearTimeout(this.watchdog);
    this.wantRunning = false;
    this.#teardown();
    this.#set('error', { qr: null, pairingCode: null, error: { kind, ...ERRORS[kind], ...extra } });
  }

  /** User pressed “Link”: always start clean unless already linked */
  async link({ phone } = {}) {
    let p = null;
    if (phone) {
      p = normalizePhone(phone);
      if (!p) throw new Error('That phone number doesn’t look right. Use your WhatsApp number, e.g. 0803 123 4567 or +234 803 123 4567.');
    }
    if (!this.hasSession()) fs.rmSync(this.authDir, { recursive: true, force: true });
    this.pairPhone = p;
    this.qrCycles = 0;
    this.retries = 0;
    this.error = null;
    clearTimeout(this.watchdog);
    this.watchdog = setTimeout(() => {
      if (['starting', 'reconnecting'].includes(this.status)) this.#fail('network');
    }, this.watchdogMs);
    await this.start();
  }

  /** (Re)open the socket. Never returns early — a stale socket is always replaced. */
  async start() {
    this.wantRunning = true;
    this.#teardown();
    const gen = ++this.gen;
    if (!['pairing', 'reconnecting'].includes(this.status)) this.#set('starting', { qr: null, pairingCode: null });
    const { state, saveCreds } = await useMultiFileAuthState(this.authDir);
    let version;
    if (this.fetchVersion) { try { ({ version } = await withTimeout(fetchLatestBaileysVersion(), 6000)); } catch { /* use bundled */ } }
    if (gen !== this.gen) return;
    const sock = this.makeSocket({
      ...(version ? { version } : {}),
      auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
      logger,
      browser: Browsers.macOS('Desktop'),
      markOnlineOnConnect: false,   // keep notifications flowing to your phone
      syncFullHistory: false,
      generateHighQualityLinkPreview: false,
      connectTimeoutMs: 30000,
      getMessage: async key => this.msgCache.get(key.id),
    });
    this.sock = sock;
    sock.ev.on('creds.update', saveCreds);

    let codeRequested = false;
    sock.ev.on('connection.update', async u => {
      if (gen !== this.gen) return;                       // event from an old socket
      const { connection, lastDisconnect, qr, isNewLogin } = u;

      if (qr) {
        if (this.pairPhone && !state.creds.registered) {
          if (codeRequested) return;
          codeRequested = true;
          try {
            const code = await sock.requestPairingCode(this.pairPhone);
            this.#set('code', { pairingCode: code?.match(/.{1,4}/g)?.join('-') || code, qr: null, qrExpiresAt: Date.now() + 160000 });
            console.log(`\n  ▶ WhatsApp pairing code for +${this.pairPhone}:  ${this.pairingCode}\n    Phone → WhatsApp → Settings → Linked devices → Link a device → Link with phone number instead\n`);
          } catch (e) {
            this.#fail('refused', { detail: `Pairing code request failed: ${e.message}` });
          }
        } else if (!this.pairPhone) {
          if (++this.qrCycles > 6) return this.#fail('qr_expired');
          this.qrRaw = qr;
          this.#set('qr', { qr: await QRCode.toDataURL(qr, { margin: 1, width: 420, errorCorrectionLevel: 'M', color: { dark: '#0b1210', light: '#ffffff' } }), qrExpiresAt: Date.now() + 20000 });
          if (this.qrCycles === 1 || this.qrCycles % 3 === 0) {
            QRCode.toString(qr, { type: 'terminal', small: true }).then(t => console.log(`\n  ▶ Scan with WhatsApp → Settings → Linked devices → Link a device\n${t}`)).catch(() => {});
          }
        }
      }

      if (isNewLogin) this.#set('pairing', { qr: null, pairingCode: null });     // scanned — finishing up

      if (connection === 'open') {
        clearTimeout(this.watchdog);
        this.retries = 0;
        const id = jidNormalizedUser(sock.user?.id);
        this.me = { id, lid: sock.user?.lid ? jidNormalizedUser(sock.user.lid) : null, name: sock.user?.name || sock.user?.notify || '', phone: jidDecode(id)?.user };
        this.#set('open', { qr: null, pairingCode: null, pairPhone: null, error: null, qrExpiresAt: null });
      }

      if (connection === 'close') {
        const code = lastDisconnect?.error?.output?.statusCode;
        const wasLinking = ['starting', 'qr', 'code', 'pairing'].includes(this.status);
        this.emit('closed', { code, status: this.status });
        if (!this.wantRunning) return this.#set('idle', { qr: null, pairingCode: null });

        if (code === DisconnectReason.restartRequired) {   // 515 — normal right after scanning
          this.#teardown();
          return setTimeout(() => this.start(), 300);
        }
        if (code === DisconnectReason.loggedOut) {          // 401
          fs.rmSync(this.authDir, { recursive: true, force: true });
          this.me = null;
          return this.#fail(wasLinking ? 'refused' : 'logged_out');
        }
        if (code === DisconnectReason.forbidden) return this.#fail('banned');
        if (code === DisconnectReason.connectionReplaced) return this.#fail('replaced');
        if (code === DisconnectReason.badSession || code === DisconnectReason.multideviceMismatch) {
          fs.rmSync(this.authDir, { recursive: true, force: true });
          return this.#fail('bad_session');
        }
        if (code === 405) return this.#fail('outdated');
        if (code === DisconnectReason.timedOut && ['qr', 'code'].includes(this.status)) return this.#fail('qr_expired');

        // network blips etc. → back off and retry
        this.retries++;
        if (wasLinking && this.status !== 'pairing' && this.retries > 4) return this.#fail('network', { detail: `code ${code ?? 'none'}` });
        const wait = Math.min(60000, 1500 * 2 ** Math.min(this.retries, 6));
        this.#teardown();
        this.#set(this.status === 'pairing' ? 'pairing' : 'reconnecting', { qr: null });
        setTimeout(() => { if (this.wantRunning) this.start(); }, wait);
      }
    });

    const learnContacts = list => {
      for (const c of list || []) {
        const name = c.name || c.verifiedName;
        if (!name) continue;
        for (const id of [c.id, c.lid, c.phoneNumber, c.jid].filter(Boolean)) this.contacts.set(jidNormalizedUser(id), name);
      }
    };
    sock.ev.on('contacts.upsert', learnContacts);
    sock.ev.on('contacts.update', learnContacts);
    sock.ev.on('messaging-history.set', ({ contacts }) => learnContacts(contacts));

    sock.ev.on('presence.update', ({ id, presences }) => {
      for (const [who, p] of Object.entries(presences || {})) {
        if (this.me && [this.me.id, this.me.lid].includes(jidNormalizedUser(who))) continue;
        this.emit('presence', { jid: id, state: p?.lastKnownPresence, ts: Date.now() });
      }
    });

    sock.ev.on('messages.upsert', ({ messages, type }) => {
      for (const m of messages) {
        try { this.#handle(m, type); } catch (e) { this.emit('error', e); }
      }
    });
  }

  #handle(m, type) {
    const key = m.key || {};
    const jid = key.remoteJid;
    if (!jid || isJidBroadcast(jid) || isJidNewsletter?.(jid) || jid === 'status@broadcast') return;
    const content = extractContent(m.message);
    if (!content) return;
    const ts = (Number(m.messageTimestamp) || Date.now() / 1000) * 1000;
    if (Date.now() - ts > 10 * 60e3) return;               // ignore old/history messages
    const isGroup = !!isJidGroup(jid);
    const phoneJid = isGroup ? null : (key.remoteJidAlt && key.remoteJidAlt.endsWith('@s.whatsapp.net') ? key.remoteJidAlt : (jid.endsWith('@s.whatsapp.net') ? jid : null));
    const self = this.me && [this.me.id, this.me.lid].includes(jidNormalizedUser(jid));
    const evt = {
      jid, isGroup, self, type,
      phone: phoneJid ? jidDecode(phoneJid)?.user : null,
      name: m.pushName || '',
      savedName: this.savedName(jid) || this.savedName(key.remoteJidAlt) || '',
      author: isGroup ? (key.participantAlt || key.participant) : null,
      fromMe: !!key.fromMe,
      byTwinly: this.sentIds.has(key.id) || (!!key.fromMe && this.sendingTo.has(jid)),
      key, ts, ...content,
    };
    this.emit('message', evt);
  }

  savedName(jid) { return jid ? this.contacts.get(jidNormalizedUser(jid)) : undefined; }

  async watchPresence(jid) {
    if (this.status !== 'open' || this.subscribed.has(jid)) return;
    this.subscribed.add(jid);
    try { await this.sock.presenceSubscribe(jid); } catch { this.subscribed.delete(jid); }
  }

  async setPresence(type, jid) {
    if (this.status !== 'open') return;
    try { await this.sock.sendPresenceUpdate(type, jid); } catch { /* ignore */ }
  }

  /**
   * Type and send bubbles like a person: "typing…" for as long as the text would take,
   * occasional mid-message pauses, short gaps between bubbles.
   * @param {{cps:number, shouldAbort?:()=>boolean, quoted?:object}} opts
   */
  async sendBubbles(jid, bubbles, { cps = 4, shouldAbort, quoted } = {}) {
    if (this.status !== 'open') throw new Error('WhatsApp is not connected');
    const sent = [];
    this.sendingTo.add(jid);
    try {
      for (let i = 0; i < bubbles.length; i++) {
        if (shouldAbort?.()) break;
        const text = bubbles[i];
        const speed = cps * (0.75 + Math.random() * 0.5);
        let typeMs = Math.min(45000, (text.length / speed) * 1000 + 600 + Math.random() * 900);
        await this.setPresence('composing', jid);
        if (text.length > 45 && Math.random() < 0.35) {                // stop, re-read, carry on typing
          const first = typeMs * (0.35 + Math.random() * 0.3);
          await sleep(first); typeMs -= first;
          await this.setPresence('paused', jid);
          await sleep(1200 + Math.random() * 2800);
          if (shouldAbort?.()) break;
          await this.setPresence('composing', jid);
        }
        await sleep(typeMs);
        if (shouldAbort?.()) break;
        const res = await this.sock.sendMessage(jid, { text }, i === 0 && quoted ? { quoted } : undefined);
        if (res?.key?.id) { this.sentIds.add(res.key.id); this.msgCache.set(res.key.id, res.message); }
        sent.push(text);
        if (i < bubbles.length - 1) await sleep(250 + Math.random() * 1100);
      }
    } finally {
      await this.setPresence('paused', jid);
      setTimeout(() => this.sendingTo.delete(jid), 1500);
    }
    if (this.sentIds.size > 5000) this.sentIds = new Set([...this.sentIds].slice(-2000));
    if (this.msgCache.size > 500) this.msgCache = new Map([...this.msgCache].slice(-200));
    return sent;
  }

  async react(jid, key, emoji) {
    if (this.status !== 'open' || !key) return;
    this.sendingTo.add(jid);
    try { await this.sock.sendMessage(jid, { react: { text: emoji, key } }); } finally { setTimeout(() => this.sendingTo.delete(jid), 1500); }
  }

  async markRead(keys) { try { await this.sock?.readMessages(keys); } catch { /* ignore */ } }

  async notifySelf(text) {
    if (this.status !== 'open' || !this.me?.id) return;
    this.sendingTo.add(this.me.id);
    try {
      const res = await this.sock.sendMessage(this.me.id, { text });
      if (res?.key?.id) this.sentIds.add(res.key.id);
    } finally { setTimeout(() => this.sendingTo.delete(this.me.id), 1500); }
  }

  #teardown() {
    const sock = this.sock;
    this.sock = null;
    if (!sock) return;
    try { sock.ev.removeAllListeners(); } catch { /* ignore */ }
    try { sock.end(undefined); } catch { /* ignore */ }
  }

  async stop() {
    this.wantRunning = false;
    clearTimeout(this.watchdog);
    this.gen++;
    this.#teardown();
    this.#set('idle', { qr: null, pairingCode: null, pairPhone: null });
  }

  async logout() {
    this.wantRunning = false;
    clearTimeout(this.watchdog);
    this.gen++;
    try { await this.sock?.logout(); } catch { /* ignore */ }
    this.#teardown();
    fs.rmSync(this.authDir, { recursive: true, force: true });
    this.me = null;
    this.#set('idle', { qr: null, pairingCode: null, pairPhone: null, error: null });
  }
}
