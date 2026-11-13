// Twinly — the auto-reply brain.
// Replies like a person: waits as long as YOU usually take, sleeps when you sleep, lets people finish
// typing, opens the chat (blue ticks), reads, thinks, types at your speed, sends separate bubbles,
// and folds in anything new that arrives before it answers.
import { EventEmitter } from 'node:events';
import { generateReply } from './persona.js';
import { Retriever } from './retriever.js';
import { rid } from './store.js';
import { tokenize } from './analyzer.js';

const today = () => new Date().toISOString().slice(0, 10);
const rand = (a, b) => a + Math.random() * (b - a);
const sleep = ms => new Promise(r => setTimeout(r, Math.max(0, ms)));
const DAY = 1440;

export function fmtDur(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60), r = m % 60;
  return r ? `${h}h ${r}m` : `${h}h`;
}

/** Interpolate a 21-point quantile table (minutes) at u ∈ [0,1] */
function sampleQ(q, u) {
  const x = Math.min(0.9999, Math.max(0, u)) * 20, i = Math.floor(x), f = x - i;
  return q[i] * (1 - f) + q[Math.min(20, i + 1)] * f;
}
const hm = s => { const [h, m] = String(s || '0:0').split(':').map(Number); return ((h || 0) * 60 + (m || 0)) % DAY; };
const minOfDay = ts => { const d = new Date(ts); return d.getHours() * 60 + d.getMinutes(); };
const inRange = (m, r) => (r.start <= r.end ? m >= r.start && m < r.end : m >= r.start || m < r.end);

function nameScore(a, b) {
  const A = new Set(tokenize(a)), B = new Set(tokenize(b));
  if (!A.size || !B.size) return 0;
  let hit = 0; for (const t of A) if (B.has(t)) hit++;
  return hit / Math.max(A.size, B.size);
}

export class Engine extends EventEmitter {
  constructor(store, wa) {
    super();
    this.store = store;
    this.wa = wa;
    this.retriever = new Retriever(store.profile?.pairs || []);
    this.plans = new Map();      // jid → pending reply plan
    this.presence = new Map();   // jid → { state, ts }
    this.lastSent = new Map();   // jid → ts Twinly last sent
    this.lastOwner = new Map();  // jid → ts you last typed yourself
    this.takeover = new Map();   // jid → until
    wa.on('message', e => this.onMessage(e).catch(err => this.#log('error', `Message handling failed: ${err.message}`)));
    wa.on('presence', p => this.presence.set(p.jid, p));
  }

  get s() { return this.store.state.settings; }
  get o() { return this.store.profile?.overall; }

  reloadProfile() { this.retriever.build(this.store.profile?.pairs || []); }

  #log(type, text, extra) { const e = this.store.log(type, text, extra); this.emit('log', e); return e; }
  #changed(what) { this.store.save(); this.emit('changed', what); }

  // ───────────── human model ─────────────

  /** typing speed in chars/sec: your setting → learned → 4 */
  cps() { return this.s.typingCps > 0 ? this.s.typingCps : (this.o?.typingCps || 4); }

  /** your sleep window in minutes-of-day, or null */
  sleepRange() {
    const sl = this.s.sleep || {};
    if (sl.mode === 'off') return null;
    if (sl.mode === 'custom') return { start: hm(sl.start), end: hm(sl.end) };
    const L = this.o?.sleep;
    return L ? { start: L.start * 60, end: L.end * 60 } : null;
  }

  #nextWake(ts, r) {
    const d = new Date(ts);
    const wake = new Date(d.getFullYear(), d.getMonth(), d.getDate(), Math.floor(r.end / 60), r.end % 60);
    if (wake.getTime() <= ts) wake.setDate(wake.getDate() + 1);
    return wake.getTime();
  }

  /** How long a real you would take before opening this chat */
  delayFor(jid, contact) {
    const s = this.s, now = Date.now();
    const active = now - Math.max(this.lastSent.get(jid) || 0, this.lastOwner.get(jid) || 0) < 6 * 60e3;
    let ms;
    if (!s.humanTiming) {
      ms = rand(s.minDelaySec, Math.max(s.minDelaySec, s.maxDelaySec)) * 1000;
    } else {
      const cs = contact?.stats;
      const q = cs?.latencySamples >= 8 && cs.latencyQ ? cs.latencyQ : this.o?.latencyQ;
      let u = Math.random();
      if (active) u *= 0.35;                                   // mid-conversation → you answer quicker
      const min = q ? sampleQ(q, u) : (active ? rand(0.2, 1.5) : rand(0.5, 8));
      ms = min < 1 ? rand(6, 55) * 1000 : min * 60e3 * rand(0.85, 1.15);
      ms *= s.latencyScale || 1;
      const cap = s.maxDelayMin * 60e3;
      if (ms > cap) ms = cap * rand(0.6, 1);
    }
    ms = Math.max(ms, s.minDelaySec * 1000, s.debounceSec * 1000);
    const r = this.sleepRange();
    if (r && inRange(minOfDay(now + ms), r)) ms = this.#nextWake(now + ms, r) - now + rand(4, 55) * 60e3;
    return Math.round(ms);
  }

  #composing(jid) {
    const p = this.presence.get(jid);
    return p && (p.state === 'composing' || p.state === 'recording') && Date.now() - p.ts < 25000;
  }
  #takenOver(jid) { return (this.takeover.get(jid) || 0) > Date.now(); }

  // ───────────── contacts ─────────────

  /** Merge analyzed contact + your overrides into one object */
  contact(id) {
    if (!id) return null;
    const base = this.store.profile?.contacts?.find(c => c.id === id) || { id, name: id };
    return { ...base, ...(this.store.state.contacts[id] || {}) };
  }

  /** Find the imported chat this WhatsApp chat belongs to (saved contact name first, then profile name) */
  resolve(live) {
    if (live.contactId !== undefined) return live.contactId;
    const contacts = (this.store.profile?.contacts || []).filter(c => c.isGroup === !!live.isGroup);
    const names = [live.savedName, live.name].filter(Boolean);
    let best = null, bestScore = 0;
    for (const c of contacts) {
      const cn = [c.name, this.store.state.contacts[c.id]?.displayName].filter(Boolean);
      for (const a of names) for (const b of cn) {
        const sc = a.trim().toLowerCase() === b.trim().toLowerCase() ? 1.01 : nameScore(a, b);
        if (sc > bestScore) { best = c; bestScore = sc; }
      }
    }
    if (best && bestScore >= 0.99) {
      live.contactId = best.id;
      this.#log('link', `Linked ${live.savedName || live.name || '+' + live.phone} → imported chat "${best.name}"`);
      return best.id;
    }
    return null;
  }

  // ───────────── incoming ─────────────

  async onMessage(e) {
    const st = this.store.state;
    if (e.self) return;
    const live = st.live[e.jid] ||= { jid: e.jid, isGroup: e.isGroup, name: '', phone: e.phone, history: [], firstSeen: Date.now() };
    if (!e.fromMe && e.name && !e.isGroup) live.name = e.name;
    if (e.savedName) live.savedName = e.savedName;
    if (e.phone) live.phone = e.phone;
    live.lastTs = e.ts;
    live.history.push({ fromMe: e.fromMe, text: e.text, ts: e.ts, by: e.byTwinly ? 'twinly' : undefined, author: e.isGroup && !e.fromMe ? e.name : undefined });
    this.emit('live', live);

    if (e.fromMe) {
      if (!e.byTwinly) {
        // you replied yourself → step back from this chat for a while
        this.lastOwner.set(e.jid, Date.now());
        this.takeover.set(e.jid, Date.now() + this.s.takeoverMinutes * 60e3);
        this.cancel(e.jid, 'you replied yourself');
        let n = 0;
        for (const q of st.queue) if (q.jid === e.jid && q.status === 'pending') { q.status = 'superseded'; n++; }
        if (n) this.#changed('queue');
      }
      this.store.save();
      return;
    }

    const cid = this.resolve(live);
    if (this.s.mode === 'off') return this.store.save();
    if (e.isGroup && !this.s.groups) return this.store.save();
    const override = cid ? st.contacts[cid] : st.contacts[`jid:${e.jid}`];
    const enabled = this.s.replyScope === 'all' ? override?.enabled !== false : override?.enabled === true;
    if (!enabled || this.#takenOver(e.jid)) return this.store.save();

    this.wa.watchPresence?.(e.jid);
    const text = e.isGroup ? `(${e.name || 'someone'}) ${e.text}` : e.text;
    let plan = this.plans.get(e.jid);
    if (!plan) {
      plan = { id: rid(), jid: e.jid, texts: [text], keys: [e.key], firstTs: e.ts, phase: 'waiting', extra: [], cancelled: false };
      this.plans.set(e.jid, plan);
      this.#arm(plan, this.delayFor(e.jid, this.contact(cid)));
    } else if (plan.phase === 'waiting') {
      plan.texts.push(text); plan.keys.push(e.key);
      const minDue = Date.now() + this.s.debounceSec * 1000;
      if (plan.dueAt < minDue) this.#arm(plan, minDue - Date.now());
    } else if (plan.phase === 'working') {
      plan.texts.push(text); plan.keys.push(e.key); plan.restart = true;   // re-read before answering
    } else {
      plan.extra.push({ text, key: e.key, ts: e.ts });                     // answer after current bubbles
    }
    this.store.save();
  }

  #arm(plan, ms) {
    clearTimeout(plan.timer);
    plan.dueAt = Date.now() + ms;
    plan.timer = setTimeout(() => this.#run(plan).catch(err => {
      this.#log('error', `Reply failed for ${this.#name(plan.jid)}: ${err.message}`);
      this.#finish(plan);
    }), ms);
    this.emit('changed', 'plans');
  }

  cancel(jid, why) {
    const plan = this.plans.get(jid);
    if (!plan) return;
    plan.cancelled = true;
    clearTimeout(plan.timer);
    this.plans.delete(jid);
    if (why) this.#log('skip', `Cancelled reply to ${this.#name(jid)} — ${why}`, { jid });
    this.emit('changed', 'plans');
  }

  /** Answer now instead of waiting (dashboard "reply now") */
  rush(jid) { const p = this.plans.get(jid); if (p && p.phase === 'waiting') this.#arm(p, 1000); }

  #finish(plan) {
    if (this.plans.get(plan.jid) === plan) this.plans.delete(plan.jid);
    this.emit('changed', 'plans');
    if (plan.extra.length && !plan.cancelled && !this.#takenOver(plan.jid)) {
      const next = { id: rid(), jid: plan.jid, texts: plan.extra.map(x => x.text), keys: plan.extra.map(x => x.key), firstTs: plan.extra[0].ts, phase: 'waiting', extra: [], cancelled: false };
      this.plans.set(plan.jid, next);
      this.#arm(next, this.delayFor(plan.jid, this.contact(this.store.state.live[plan.jid]?.contactId)));
    }
  }

  #name(jid) { const l = this.store.state.live[jid]; return l?.savedName || l?.name || (l?.phone ? '+' + l.phone : 'Unknown'); }

  plansView() {
    return [...this.plans.values()].map(p => ({ jid: p.jid, name: this.#name(p.jid), dueAt: p.dueAt, phase: p.phase, count: p.texts.length }));
  }

  // ───────────── the reply itself ─────────────

  async #run(plan) {
    const { jid } = plan;
    const st = this.store.state;
    if (plan.cancelled || this.plans.get(jid) !== plan) return;
    if (this.#takenOver(jid)) return this.#finish(plan);
    plan.phase = 'working';
    this.emit('changed', 'plans');

    // they're still typing → give them a moment (up to ~2 min)
    for (let i = 0; i < 30 && this.#composing(jid); i++) await sleep(4000);
    if (plan.cancelled) return;

    const name = this.#name(jid);
    const capKey = `${today()}:${jid}`;
    if ((st.daily[capKey] || 0) >= this.s.dailyCapPerChat) {
      this.#log('cap', `Daily limit reached for ${name} — not replying until tomorrow`, { jid });
      plan.extra = [];
      return this.#finish(plan);
    }

    // "open" the chat → blue ticks now, not when the message arrived
    await this.wa.setPresence?.('available');
    if (this.s.markRead) await this.wa.markRead(plan.keys);
    const opened = Date.now();

    const live = st.live[jid];
    const contact = this.contact(live?.contactId) || { id: `jid:${jid}`, name, isGroup: live?.isGroup, ...(st.contacts[`jid:${jid}`] || {}) };
    const history = (live?.history || []).filter(h => h.ts < plan.firstTs).slice(-24);
    const res = await generateReply({
      profile: this.store.profile, retriever: this.retriever, contact, history, incoming: plan.texts, settings: this.s, llm: this.s.llm,
    });
    if (plan.cancelled) return;
    if (plan.restart) {                                   // more messages landed while reading → re-read
      plan.restart = false; plan.phase = 'waiting';
      return this.#arm(plan, rand(5, 12) * 1000);
    }

    // reading + thinking time before typing
    const readMs = Math.min(15000, (plan.texts.join(' ').length / 22) * 1000) + rand(1200, 5000);
    await sleep(opened + readMs - Date.now());
    if (plan.cancelled || this.#takenOver(jid)) return this.#finish(plan);
    if (plan.restart) { plan.restart = false; plan.phase = 'waiting'; return this.#arm(plan, rand(4, 9) * 1000); }

    const auto = this.s.mode === 'auto';
    const waited = fmtDur(Date.now() - plan.firstTs);

    if (res.action === 'skip') {
      st.totals.skipped++;
      this.#log('skip', `Left ${name} on read${res.reason ? ` — ${res.reason}` : ''}`, { jid });
    } else if (res.action === 'react') {
      await sleep(rand(600, 2000));
      await this.wa.react(jid, plan.keys[plan.keys.length - 1], res.emoji);
      st.totals.sent++;
      this.#log('react', `Reacted ${res.emoji} to ${name}`, { jid, incoming: plan.texts });
    } else if (res.action === 'escalate' || (res.action === 'hold' && !auto) || (res.action === 'reply' && !auto) || (res.action === 'hold' && this.s.escalation === 'queue')) {
      this.#queue(plan, res, name);
    } else {
      // reply / hold → type and send like a person
      plan.phase = 'sending';
      this.emit('changed', 'plans');
      const sent = await this.wa.sendBubbles(jid, res.messages, { cps: this.cps(), shouldAbort: () => plan.cancelled || this.#takenOver(jid) });
      if (sent.length) {
        this.lastSent.set(jid, Date.now());
        st.daily[capKey] = (st.daily[capKey] || 0) + 1;
        st.totals.sent++;
        if (res.action === 'hold') {
          st.totals.escalated++;
          this.#log('hold', `Held ${name} off — ${res.reason || 'sensitive'} (you were pinged)`, { jid, incoming: plan.texts, messages: sent });
          this.#ping(name, res.reason || 'Sensitive topic', plan.texts, sent, true);
        } else {
          this.#log('sent', `Replied to ${name} after ${waited}`, { jid, incoming: plan.texts, messages: sent });
        }
      }
    }
    setTimeout(() => { if (!this.plans.size) this.wa.setPresence?.('unavailable'); }, rand(8, 45) * 1000);
    this.#changed('totals');
    this.#finish(plan);
  }

  #queue(plan, res, name) {
    const st = this.store.state;
    const esc = res.action === 'escalate' || res.action === 'hold';
    const why = esc ? (res.reason || 'Needs you') : 'Waiting for approval';
    st.queue.push({ id: rid(), ts: Date.now(), jid: plan.jid, contactId: this.store.state.live[plan.jid]?.contactId, name, incoming: plan.texts, draft: res.messages, action: esc ? 'escalate' : 'reply', reason: why, status: 'pending' });
    if (esc) st.totals.escalated++; else st.totals.drafted++;
    this.#log(esc ? 'escalate' : 'draft', `${esc ? 'Needs you' : 'Draft ready'}: ${name} — ${why}`, { jid: plan.jid });
    if (esc) this.#ping(name, why, plan.texts, res.messages, false);
    this.#changed('queue');
  }

  #ping(name, why, incoming, msgs, sent) {
    if (!this.s.notifySelf) return;
    this.wa.notifySelf(`🔔 *Twinly — ${name}*\n_${why}_\n\n“${incoming.join(' / ').slice(0, 400)}”${msgs?.length ? `\n\n${sent ? 'I replied:' : 'Suggested reply:'}\n${msgs.join('\n')}` : '\n\n(I did not reply)'}`).catch(() => {});
  }

  async approve(id, messages) {
    const q = this.store.state.queue.find(x => x.id === id);
    if (!q || q.status !== 'pending') throw new Error('This draft is no longer pending');
    const bubbles = (messages || q.draft).map(s => String(s).trim()).filter(Boolean);
    if (!bubbles.length) throw new Error('Nothing to send');
    await this.wa.sendBubbles(q.jid, bubbles, { cps: this.cps() * 1.5 });
    q.status = 'sent'; q.sent = bubbles; q.doneTs = Date.now();
    const capKey = `${today()}:${q.jid}`;
    this.store.state.daily[capKey] = (this.store.state.daily[capKey] || 0) + 1;
    this.store.state.totals.sent++;
    this.lastSent.set(q.jid, Date.now());
    this.#log('sent', `Sent approved reply to ${q.name}`, { jid: q.jid, incoming: q.incoming, messages: bubbles });
    this.#changed('queue');
  }

  reject(id) {
    const q = this.store.state.queue.find(x => x.id === id);
    if (q && q.status === 'pending') { q.status = 'discarded'; q.doneTs = Date.now(); this.#changed('queue'); }
  }
}
