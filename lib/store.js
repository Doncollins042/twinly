// Twinly — tiny JSON persistence (no database required)
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_ESCALATE } from './persona.js';

export const DEFAULT_SETTINGS = {
  mode: 'auto',               // 'auto' = replies on its own · 'approve' = drafts wait for you · 'off'
  replyScope: 'all',          // 'all' = everyone except contacts you switch off · 'enabled' = only contacts you switch on
  groups: false,
  // ── human behaviour ──
  humanTiming: true,          // reply after the same kind of delay YOU take (learned from your chats)
  latencyScale: 1,            // 0.5 = twice as fast as you, 2 = twice as slow
  maxDelayMin: 90,            // never wait longer than this (outside sleep hours)
  minDelaySec: 8,             // used when humanTiming is off, and as the floor
  maxDelaySec: 60,
  debounceSec: 12,            // let them finish a burst of messages first
  typingCps: 0,               // 0 = use your learned typing speed (fallback 4 chars/sec)
  sleep: { mode: 'learned', start: '23:30', end: '06:30' },   // 'learned' | 'custom' | 'off'
  markRead: true,             // blue ticks appear when your twin "opens" the chat, not instantly
  reactions: true,            // react with an emoji instead of replying when that's what you'd do
  escalation: 'hold',         // sensitive topics: 'hold' = send a non-committal reply + ping you · 'silent' = don't reply, ping you · 'queue' = draft for approval
  dailyCapPerChat: 60,
  takeoverMinutes: 20,        // if you reply yourself, Twinly steps back from that chat
  notifySelf: true,           // pings go to your own "Message yourself" chat
  // ── voice ──
  ownerDisplayName: '',
  statusNotes: '',
  customInstructions: '',
  escalateTopics: DEFAULT_ESCALATE,
  temperature: 0.85,
  examplesK: 8,
  llm: { provider: 'anthropic', model: '', apiKey: '' },
};
export const SETTINGS_VERSION = 2;

export class Store {
  constructor(dir) {
    this.dir = dir;
    this.chatsDir = path.join(dir, 'chats');
    fs.mkdirSync(this.chatsDir, { recursive: true });
    this.statePath = path.join(dir, 'state.json');
    this.profilePath = path.join(dir, 'profile.json');
    this.state = this.#read(this.statePath, {});
    const saved = this.state.settings || {};
    if ((this.state.settingsVersion || 1) < SETTINGS_VERSION) {
      // v1 → v2: fully automatic, human-timed by default
      for (const k of ['mode', 'replyScope', 'minConfidence', 'typingCps', 'dailyCapPerChat', 'debounceSec', 'takeoverMinutes', 'minDelaySec', 'maxDelaySec']) delete saved[k];
      delete saved.quietHours;
      this.state.settingsVersion = SETTINGS_VERSION;
    }
    this.state.settings = deepMerge(structuredClone(DEFAULT_SETTINGS), saved);
    this.state.contacts ||= {};   // contactId → { enabled, relationship, nickname, notes, displayName }
    this.state.live ||= {};       // jid → { jid, name, phone, contactId, lastTs, history: [] }
    this.state.queue ||= [];
    this.state.log ||= [];
    this.state.daily ||= {};      // `${day}:${jid}` → count
    this.state.totals ||= { sent: 0, drafted: 0, escalated: 0, skipped: 0 };
    this.profile = this.#read(this.profilePath, null);
    this._t = null;
  }

  #read(p, fallback) {
    try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
  }

  save() {
    clearTimeout(this._t);
    this._t = setTimeout(() => this.flush(), 400);
  }

  flush() {
    clearTimeout(this._t);
    this.state.log = this.state.log.slice(-500);
    this.state.queue = this.state.queue.filter(q => q.status === 'pending' || Date.now() - q.ts < 3 * 86400e3).slice(-300);
    const today = new Date().toISOString().slice(0, 10);
    for (const k of Object.keys(this.state.daily)) if (!k.startsWith(today)) delete this.state.daily[k];
    for (const l of Object.values(this.state.live)) l.history = (l.history || []).slice(-60);
    fs.writeFileSync(this.statePath + '.tmp', JSON.stringify(this.state));
    fs.renameSync(this.statePath + '.tmp', this.statePath);
  }

  saveProfile(profile) {
    this.profile = profile;
    fs.writeFileSync(this.profilePath, JSON.stringify(profile));
  }

  // ---- imported chats ----
  saveChat(chat) { fs.writeFileSync(path.join(this.chatsDir, `${chat.id}.json`), JSON.stringify(chat)); }
  listChats({ withMessages = false } = {}) {
    return fs.readdirSync(this.chatsDir).filter(f => f.endsWith('.json')).map(f => {
      const c = this.#read(path.join(this.chatsDir, f), null);
      if (!c) return null;
      if (!withMessages) delete c.messages;
      return c;
    }).filter(Boolean).sort((a, b) => (b.last || 0) - (a.last || 0));
  }
  deleteChat(id) { try { fs.unlinkSync(path.join(this.chatsDir, `${path.basename(id)}.json`)); } catch { /* gone */ } }

  wipe() {
    fs.rmSync(this.chatsDir, { recursive: true, force: true });
    fs.mkdirSync(this.chatsDir, { recursive: true });
    try { fs.unlinkSync(this.profilePath); } catch { /* none */ }
    this.profile = null;
    const settings = this.state.settings;
    this.state = { settingsVersion: SETTINGS_VERSION, settings, contacts: {}, live: {}, queue: [], log: [], daily: {}, totals: { sent: 0, drafted: 0, escalated: 0, skipped: 0 } };
    this.flush();
  }

  log(type, text, extra = {}) {
    const entry = { id: rid(), ts: Date.now(), type, text, ...extra };
    this.state.log.push(entry);
    this.save();
    return entry;
  }
}

export const rid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

function deepMerge(base, over) {
  for (const [k, v] of Object.entries(over || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) deepMerge(base[k], v);
    else if (v !== undefined) base[k] = v;
  }
  return base;
}
export { deepMerge };
