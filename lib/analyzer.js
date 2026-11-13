// Twinly — Style DNA analyzer
// Reads parsed chats and learns how the owner writes: length, rhythm, emoji, slang,
// greetings, laughter, language mix, timing, and per-contact tone + real reply pairs.

const EMOJI_RE = /\p{Extended_Pictographic}(?:️|‍\p{Extended_Pictographic}|[\u{1F3FB}-\u{1F3FF}])*/gu;
const WORD_RE = /[\p{L}\p{N}']+/gu;

const STOP = new Set(`a an the and or but if to of in on at for with from by is are was were be been am i me my you your u ur we us our it its this that these those he she him her they them their do does did done have has had will would can could should not no yes so just as up out about what when where who how why then than there here too very also all any some more most into over again only own same such each few both other off ok okay im i'm it's don't dont`.split(/\s+/));

const PIDGIN = new Set(`abeg wetin dey na una wey sabi abi oya omo wahala comot shey sef sha jare ehn ehen chop pikin gist nawa wan go don make fit kpele kpele biko nna nne nwanne ngwa o oo ooo jor shebi wahala dey sha haba chai e no ehn ehen ah aswear walahi nawao waka gbege kolo yawa`.split(/\s+/));
const SLANG = new Set(`u ur r y pls plz abt bcos bcoz cos coz cuz tho thru wat wht dat dis d tmrw tmr tmrw 2moro 2day 2nite gn gm hbu wbu wyd idk idc imo tbh smh lol lmao lmfao rofl omg brb ttyl btw ikr nvm fr frfr ngl bruh bro sis gee guy omo abeg wetin sha jor oya nah naw yea yeah yh ya yup nope k kk okk okkk ok`.split(/\s+/));
const LAUGH_RE = /\b(l+o+l+|lmf?a+o+|ha(?:ha)+h?|he(?:he)+|hi(?:hi)+|kk+|xd+|rofl)\b|😂|🤣|😅|😆|💀/giu;
const VOCATIVES = `bro brother guy guys dear dearest babe baby bae love luv sweetheart mama mummy mum mom mommy daddy dad papa sis sister boss chief oga madam ma sir padi paddy my g g nwanne nne nna nwa darling hun honey fam bestie chairman`.split(/\s+/);
const FORMAL_RE = /\b(sir|ma'?am|ma|kindly|regards|good (morning|afternoon|evening)|please|thank you|noted)\b/i;

const TURN_GAP = 30 * 60e3;          // same-author messages within 30m = one turn
const CONVO_GAP = 6 * 3600e3;        // 6h silence = new conversation
const REPLY_WINDOW = 12 * 3600e3;    // only count replies within 12h

export function slug(s) {
  return String(s || 'unknown').toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '').slice(0, 48) || 'contact';
}
export const tokenize = s => (String(s).toLowerCase().match(WORD_RE) || []);
const emojis = s => String(s).match(EMOJI_RE) || [];
const pct = (n, d) => (d ? Math.round((n / d) * 1000) / 10 : 0);
const median = a => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const quantile = (a, q) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };
const top = (obj, n, min = 1) => Object.entries(obj).filter(([, c]) => c >= min).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, c]) => ({ k, n: c }));
const inc = (o, k, by = 1) => { o[k] = (o[k] || 0) + by; };

/** 21-point quantile table (p0, p5 … p100) of latencies, in minutes */
function quantileTable(ms) {
  if (ms.length < 3) return null;
  const s = [...ms].sort((a, b) => a - b);
  return Array.from({ length: 21 }, (_, i) => Math.round((s[Math.min(s.length - 1, Math.floor((i / 20) * (s.length - 1)))] / 60e3) * 100) / 100);
}

function latencyBuckets(ms) {
  const B = [['Under 1 min', 60e3], ['1–5 min', 5 * 60e3], ['5–30 min', 30 * 60e3], ['30 min–2 h', 2 * 3600e3], ['2 h+', Infinity]];
  const out = B.map(([k]) => ({ k, n: 0 }));
  for (const l of ms) out[B.findIndex(([, max]) => l < max)].n++;
  return out.map(b => ({ k: b.k, pct: pct(b.n, ms.length) }));
}

/** Longest quiet stretch of the day (circular) → when you're usually asleep */
function sleepWindow(hours) {
  const total = hours.reduce((a, b) => a + b, 0);
  if (total < 60) return null;
  const thr = Math.max(1, (total / 24) * 0.22);
  let best = null;
  for (let start = 0; start < 24; start++) {
    if (hours[start] >= thr || hours[(start + 23) % 24] < thr) continue;   // must begin a quiet run
    let len = 0;
    while (len < 24 && hours[(start + len) % 24] < thr) len++;
    if (len >= 3 && len <= 11 && (!best || len > best.len)) best = { start, len };
  }
  if (!best) return null;
  return { start: best.start, end: (best.start + best.len) % 24 };
}

/** Group consecutive messages by the same author into turns */
function toTurns(msgs) {
  const turns = [];
  for (const m of msgs) {
    if (!m.author || m.kind === 'system') continue;
    const last = turns[turns.length - 1];
    if (last && last.author === m.author && m.ts - last.end < TURN_GAP) {
      last.msgs.push(m); last.end = m.ts;
    } else {
      turns.push({ author: m.author, start: m.ts, end: m.ts, msgs: [m] });
    }
  }
  return turns;
}

function styleStats(ownerMsgs, ownerTurns, latencies, openers, closers) {
  const texts = ownerMsgs.filter(m => m.kind === 'text').map(m => m.text);
  const n = texts.length;
  const words = texts.map(t => tokenize(t).length);
  const emo = {}, wordFreq = {}, bi = {}, tri = {}, laugh = {}, slang = {}, hours = Array(24).fill(0);
  let withEmoji = 0, lowerStart = 0, upperStart = 0, endsPeriod = 0, question = 0, exclaim = 0, ellipsis = 0, pidginMsgs = 0, allCaps = 0, formal = 0;

  for (const m of ownerMsgs) hours[new Date(m.ts).getHours()]++;
  for (const t of texts) {
    const es = emojis(t);
    if (es.length) withEmoji++;
    es.forEach(e => inc(emo, e));
    const first = t.match(/\p{L}/u)?.[0];
    if (first) { if (first === first.toLowerCase() && first !== first.toUpperCase()) lowerStart++; else upperStart++; }
    const trimmed = t.replace(EMOJI_RE, '').trim();
    if (/[^.]\.$/.test(trimmed)) endsPeriod++;
    if (/\?/.test(t)) question++;
    if (/!/.test(t)) exclaim++;
    if (/\.{2,}|…/.test(t)) ellipsis++;
    if (/\p{L}{3,}/u.test(t) && t === t.toUpperCase() && /\p{Lu}/u.test(t)) allCaps++;
    if (FORMAL_RE.test(t)) formal++;
    const toks = tokenize(t);
    let pid = false;
    toks.forEach((w, i) => {
      if (!STOP.has(w) && w.length > 1 && !/^\d+$/.test(w)) inc(wordFreq, w);
      if (SLANG.has(w)) inc(slang, w);
      if (PIDGIN.has(w)) pid = true;
      if (i > 0) inc(bi, `${toks[i - 1]} ${w}`);
      if (i > 1) inc(tri, `${toks[i - 2]} ${toks[i - 1]} ${w}`);
    });
    if (pid) pidginMsgs++;
    for (const l of t.matchAll(LAUGH_RE)) {
      const key = l[0].toLowerCase().replace(/(.)\1{2,}/g, '$1$1');
      inc(laugh, key);
    }
  }

  // phrases: keep bigrams/trigrams that aren't pure stopwords
  const phraseScore = {};
  for (const [k, c] of Object.entries(tri)) if (c >= 3 && k.split(' ').some(w => !STOP.has(w))) phraseScore[k] = c * 1.6;
  for (const [k, c] of Object.entries(bi)) if (c >= 3 && k.split(' ').some(w => !STOP.has(w))) phraseScore[k] = Math.max(phraseScore[k] || 0, c);
  const phrases = top(phraseScore, 40).map(p => ({ k: p.k, n: Math.round(p.n) }));
  // de-duplicate bigrams that are inside a kept trigram
  const keptPhrases = [];
  for (const p of phrases) {
    if (keptPhrases.some(q => q.k.includes(p.k) || p.k.includes(q.k))) continue;
    keptPhrases.push(p);
    if (keptPhrases.length >= 18) break;
  }

  const msgsPerTurn = ownerTurns.length ? ownerTurns.reduce((s, t) => s + t.msgs.length, 0) / ownerTurns.length : 1;

  return {
    messages: ownerMsgs.length,
    textMessages: n,
    avgWords: n ? Math.round((words.reduce((a, b) => a + b, 0) / n) * 10) / 10 : 0,
    medianWords: median(words),
    p90Words: quantile(words, 0.9),
    msgsPerTurn: Math.round(msgsPerTurn * 100) / 100,
    emojiRate: pct(withEmoji, n),
    topEmojis: top(emo, 12),
    lowercaseStart: pct(lowerStart, lowerStart + upperStart),
    endsWithPeriod: pct(endsPeriod, n),
    questionRate: pct(question, n),
    exclaimRate: pct(exclaim, n),
    ellipsisRate: pct(ellipsis, n),
    allCapsRate: pct(allCaps, n),
    formalRate: pct(formal, n),
    pidginRate: pct(pidginMsgs, n),
    laughter: top(laugh, 6),
    slang: top(slang, 16, 2),
    topWords: top(wordFreq, 30, 2),
    phrases: keptPhrases,
    openers: top(openers, 10, 2),
    closers: top(closers, 10, 2),
    replyLatencyMin: latencies.length ? Math.round(median(latencies) / 6e3) / 10 : null,
    fastReplyRate: pct(latencies.filter(l => l < 5 * 60e3).length, latencies.length),
    latencySamples: latencies.length,
    latencyQ: quantileTable(latencies),
    latencyBuckets: latencyBuckets(latencies),
    sleep: sleepWindow(hours),
    hours,
  };
}

function firstWords(text, n = 3) {
  return tokenize(text).slice(0, n).join(' ');
}

/**
 * Build the full profile.
 * @param {Array} chats parsed chats
 * @param {string|string[]} ownerNames name(s) the owner appears as across exports
 */
export function buildProfile(chats, ownerNames) {
  const owners = new Set([].concat(ownerNames).filter(Boolean));
  const isOwner = a => owners.has(a);
  const allOwnerMsgs = [], allOwnerTurns = [], allLat = [], openers = {}, closers = {};
  const contacts = {};
  const pairs = [];
  const samples = [];
  const cpsSamples = [];

  for (const chat of chats) {
    const msgs = chat.messages.filter(m => m.author);
    if (!msgs.some(m => isOwner(m.author))) continue;
    const others = chat.participants.filter(p => !isOwner(p.name));
    const contactName = chat.isGroup ? chat.title : (others[0]?.name || chat.title);
    const cid = (chat.isGroup ? 'group-' : '') + slug(contactName);
    const c = contacts[cid] ||= {
      id: cid, name: contactName, isGroup: chat.isGroup, chatIds: [], msgsMine: [], turnsMine: [], lat: [], openers: {}, closers: {}, voc: {}, theirMsgs: 0, last: 0,
    };
    c.chatIds.push(chat.id);
    c.last = Math.max(c.last, chat.last || 0);

    const turns = toTurns(msgs);
    const hasSeconds = msgs.some(m => m.ts % 60000 !== 0);
    const firstName = tokenize(contactName)[0];
    for (let i = 0; i < turns.length; i++) {
      const t = turns[i];
      const prev = turns[i - 1];
      const next = turns[i + 1];
      if (!isOwner(t.author)) { c.theirMsgs += t.msgs.length; continue; }
      c.msgsMine.push(...t.msgs); c.turnsMine.push(t);
      if (hasSeconds) {
        for (let k = 1; k < t.msgs.length; k++) {
          const gap = (t.msgs[k].ts - t.msgs[k - 1].ts) / 1000;
          const len = t.msgs[k].kind === 'text' ? t.msgs[k].text.length : 0;
          if (len >= 4 && gap >= 1.5 && gap <= 90) cpsSamples.push(len / gap);
        }
      }
      allOwnerMsgs.push(...t.msgs); allOwnerTurns.push(t);
      const firstText = t.msgs.find(m => m.kind === 'text')?.text;
      const lastText = [...t.msgs].reverse().find(m => m.kind === 'text')?.text;
      if (firstText && (!prev || t.start - prev.end > CONVO_GAP)) { const w = firstWords(firstText, 2); if (w) { inc(openers, w); inc(c.openers, w); } }
      if (lastText && (!next || next.start - t.end > CONVO_GAP)) { const w = firstWords(lastText, 3); if (w) { inc(closers, w); inc(c.closers, w); } }
      for (const m of t.msgs) {
        if (m.kind !== 'text') continue;
        const toks = tokenize(m.text);
        for (const v of VOCATIVES) {
          if (v.includes(' ') ? m.text.toLowerCase().includes(v) : toks.includes(v)) inc(c.voc, v);
        }
        if (firstName && firstName.length > 2 && toks.includes(firstName)) inc(c.voc, firstName);
      }
      // reply pair: the other person's turn → my reply
      if (prev && !isOwner(prev.author) && t.start - prev.end < REPLY_WINDOW) {
        const lat = t.start - prev.end;
        allLat.push(lat); c.lat.push(lat);
        const prompt = prev.msgs.filter(m => m.kind === 'text').slice(-4).map(m => m.text).join('\n');
        const reply = t.msgs.filter(m => m.kind === 'text').map(m => m.text);
        if (prompt && reply.length && prompt.length < 1200) {
          pairs.push({ c: cid, from: chat.isGroup ? prev.author : undefined, p: prompt, r: reply.slice(0, 6), ts: t.start });
        }
      }
    }
  }

  // representative samples — spread across length buckets
  const textOwner = allOwnerMsgs.filter(m => m.kind === 'text' && m.text.length > 1 && m.text.length < 400);
  const buckets = [[], [], []];
  for (const m of textOwner) { const w = tokenize(m.text).length; buckets[w <= 4 ? 0 : w <= 14 ? 1 : 2].push(m.text); }
  const pick = (arr, k) => { const out = new Set(); const step = Math.max(1, Math.floor(arr.length / k)); for (let i = arr.length - 1; i >= 0 && out.size < k; i -= step) out.add(arr[i]); return [...out]; };
  samples.push(...pick(buckets[0], 14), ...pick(buckets[1], 16), ...pick(buckets[2], 6));

  const contactList = Object.values(contacts).map(c => {
    const st = styleStats(c.msgsMine, c.turnsMine, c.lat, c.openers, c.closers);
    return {
      id: c.id,
      name: c.name,
      isGroup: c.isGroup,
      chatIds: c.chatIds,
      mine: c.msgsMine.length,
      theirs: c.theirMsgs,
      last: c.last,
      nicknames: top(c.voc, 5, 2),
      stats: {
        avgWords: st.avgWords, msgsPerTurn: st.msgsPerTurn, emojiRate: st.emojiRate, topEmojis: st.topEmojis.slice(0, 5),
        lowercaseStart: st.lowercaseStart, formalRate: st.formalRate, pidginRate: st.pidginRate, laughter: st.laughter.slice(0, 3),
        openers: st.openers.slice(0, 4), closers: st.closers.slice(0, 4), replyLatencyMin: st.replyLatencyMin, phrases: st.phrases.slice(0, 6),
        latencySamples: st.latencySamples, latencyQ: st.latencyQ,
      },
    };
  }).sort((a, b) => b.mine + b.theirs - (a.mine + a.theirs));

  pairs.sort((a, b) => a.ts - b.ts);
  const keptPairs = pairs.slice(-6000);

  const overall = styleStats(allOwnerMsgs, allOwnerTurns, allLat, openers, closers);
  // typing speed: upper-middle of the gap samples (gaps also include pauses, so median under-estimates)
  overall.typingCps = cpsSamples.length >= 15 ? Math.min(9, Math.max(1.8, Math.round(quantile(cpsSamples, 0.6) * 10) / 10)) : null;
  overall.typingSamples = cpsSamples.length;

  return {
    owner: [...owners],
    builtAt: Date.now(),
    chats: chats.length,
    range: [Math.min(...chats.map(c => c.first || Infinity)), Math.max(...chats.map(c => c.last || 0))],
    overall,
    samples,
    contacts: contactList,
    pairCount: keptPairs.length,
    pairs: keptPairs,
  };
}
