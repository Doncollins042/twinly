// Twinly — persona prompt builder + reply engine
import { complete, extractJson } from './llm.js';

export const DEFAULT_ESCALATE = [
  'requests for money, loans, transfers, account numbers or payments',
  'emergencies, illness, hospital, accidents, death or bad news',
  'fixing a specific meeting time, place or commitment',
  'serious relationship conflict, apologies or emotionally heavy conversations',
  'voice notes, images or files you cannot see',
];

const fmtList = (arr, f = x => x.k) => (arr || []).map(f).filter(Boolean).join(', ');

function styleBlock(owner, o, samples) {
  const L = [];
  L.push(`- Length: usually ${o.medianWords} words per message (avg ${o.avgWords}); rarely over ${o.p90Words}.`);
  if (o.msgsPerTurn >= 1.3) L.push(`- Rhythm: sends ~${o.msgsPerTurn} short messages per reply instead of one long one — split naturally.`);
  else L.push(`- Rhythm: usually one message per reply.`);
  L.push(`- Casing: starts ${o.lowercaseStart}% of messages in lowercase${o.allCapsRate > 3 ? `; sometimes uses ALL CAPS for emphasis (${o.allCapsRate}%)` : ''}.`);
  L.push(`- Punctuation: ends with a full stop ${o.endsWithPeriod}% of the time; "..." in ${o.ellipsisRate}%; "!" in ${o.exclaimRate}%; asks questions in ${o.questionRate}%.`);
  L.push(o.emojiRate > 0
    ? `- Emoji: in ${o.emojiRate}% of messages. Favourites: ${fmtList(o.topEmojis.slice(0, 8))}. Don't use emojis they never use.`
    : `- Emoji: almost never uses emoji.`);
  if (o.laughter?.length) L.push(`- Laughs with: ${fmtList(o.laughter)}.`);
  if (o.slang?.length) L.push(`- Spelling/slang they actually use: ${fmtList(o.slang.slice(0, 12))}.`);
  if (o.pidginRate >= 3) L.push(`- Uses Nigerian Pidgin in ~${o.pidginRate}% of messages — switch into it when the other person does.`);
  if (o.phrases?.length) L.push(`- Signature phrases: ${fmtList(o.phrases.slice(0, 12), p => `"${p.k}"`)}.`);
  if (o.openers?.length) L.push(`- How they open conversations: ${fmtList(o.openers.slice(0, 6), p => `"${p.k}"`)}.`);
  if (o.closers?.length) L.push(`- How they wrap up: ${fmtList(o.closers.slice(0, 6), p => `"${p.k}"`)}.`);
  if (o.formalRate > 12) L.push(`- Formality: polite markers (please/sir/ma/good morning) in ${o.formalRate}% of messages.`);
  const ex = (samples || []).slice(0, 30).map(s => `  • ${s.replace(/\n/g, ' ⏎ ')}`).join('\n');
  return `${L.join('\n')}\n- Real messages ${owner} has sent (copy this voice):\n${ex}`;
}

function contactBlock(contact) {
  if (!contact) return 'Unknown contact — keep it friendly, short and neutral in their voice.';
  const s = contact.stats || {};
  const L = [`Chatting with: ${contact.displayName || contact.name}${contact.relationship ? ` (${contact.relationship})` : ''}${contact.isGroup ? ' — group chat' : ''}.`];
  const nick = contact.nickname || fmtList(contact.nicknames?.slice(0, 3));
  if (nick) L.push(`- Calls them: ${nick}.`);
  if (s.avgWords) L.push(`- With them: ~${s.avgWords} words/message, emoji in ${s.emojiRate}% of messages, lowercase start ${s.lowercaseStart}%${s.pidginRate >= 3 ? `, Pidgin ${s.pidginRate}%` : ''}${s.formalRate > 10 ? `, polite/formal markers ${s.formalRate}%` : ''}.`);
  if (s.topEmojis?.length) L.push(`- Emojis used with them: ${fmtList(s.topEmojis)}.`);
  if (s.laughter?.length) L.push(`- Laughs with them using: ${fmtList(s.laughter)}.`);
  if (s.phrases?.length) L.push(`- Phrases used with them: ${fmtList(s.phrases, p => `"${p.k}"`)}.`);
  if (contact.notes) L.push(`- Owner's notes about this person: ${contact.notes}`);
  return L.join('\n');
}

export function buildSystemPrompt({ profile, contact, settings }) {
  const owner = settings.ownerDisplayName || profile?.owner?.[0] || 'the owner';
  const o = profile?.overall;
  const escalate = (settings.escalateTopics?.length ? settings.escalateTopics : DEFAULT_ESCALATE).filter(t => !/bot|\bai\b|assistant/i.test(t)).map(t => `   - ${t}`).join('\n');
  const hold = settings.mode === 'auto' && (settings.escalation || 'hold') === 'hold';
  return `You are ${owner}'s texting twin. You reply to chat messages on ${owner}'s behalf, writing AS ${owner} in first person, exactly the way ${owner} texts. You are not an assistant and must never sound like one.

# ${owner}'s texting style${o ? ` (learned from ${o.textMessages} real messages)` : ''}
${o ? styleBlock(owner, o, profile.samples) : '- No style profile yet — keep replies short, casual and natural.'}

# This chat
${contactBlock(contact)}

# What ${owner} is up to right now (only facts you may use)
${settings.statusNotes?.trim() || '(nothing provided — do not invent plans, locations or availability)'}

# Rules
1. Sound like ${owner}: mirror their message length, casing, spelling, slang, punctuation and emoji habits — and how they talk to THIS person specifically. No assistant phrases ("I hope this helps", "How can I assist", "Certainly!", "As an AI").
2. Reply in the same language/register the other person used, the way ${owner} would (English, Pidgin, Igbo, Yoruba, Hausa, etc.).
3. Never invent facts about ${owner}'s life, whereabouts, plans, money or relationships beyond the notes above. If a good reply needs a fact you don't have, keep it light and non-committal in their voice ("let me check", "I'll let you know").
4. Never promise money, agree to binding commitments, or accept/decline invitations on ${owner}'s behalf.
5. SENSITIVE topics:
${escalate}
${hold
  ? `   → use action "hold": a short, natural reply in ${owner}'s voice that buys time without promising, refusing or revealing anything (e.g. "let me check and get back to you", "I'll call you later"). Add a short "reason".`
  : `   → use action "escalate" with a short "reason" and a suggested "draft"; do not reply.`}
6. If they ask whether they're chatting with a bot, AI or assistant, ALWAYS use action "escalate" (never deny it, never confirm it).
7. If the conversation is clearly finished (e.g. "ok", "👍", "goodnight" after a wrap-up), use "skip"${settings.reactions !== false ? ` — or "react" with one emoji ${owner} actually uses, if that's what they'd do (e.g. to a thank-you)` : ''}.
${settings.customInstructions?.trim() ? `8. Extra instructions from ${owner}: ${settings.customInstructions.trim()}` : ''}

# Output format
Return ONLY a JSON object, nothing else — one of:
{"action":"reply","messages":["first message","optional second message"],"confidence":0.0-1.0}
${hold ? `{"action":"hold","messages":["non-committal reply"],"reason":"short reason"}\n` : ''}{"action":"escalate","reason":"short reason","draft":["suggested reply for ${owner}"]}
{"action":"skip","reason":"why no reply is needed"}
${settings.reactions !== false ? '{"action":"react","emoji":"👍"}\n' : ''}Each string in "messages" is sent as a separate chat bubble. Use ${o && o.msgsPerTurn >= 1.3 ? '1–3' : '1–2'} bubbles, like ${owner} does.`;
}

export function buildUserPrompt({ owner, contactName, examples, history, incoming }) {
  const ex = examples.length
    ? examples.map((e, i) => `Example ${i + 1}\nThem: ${e.p.replace(/\n/g, '\nThem: ')}\n${owner}: ${e.r.join(`\n${owner}: `)}`).join('\n\n')
    : '(no similar past exchanges found)';
  const hist = history.length
    ? history.slice(-24).map(h => `${h.fromMe ? owner : contactName}: ${h.text}`).join('\n')
    : '(no recent messages)';
  return `How ${owner} actually replied in similar past situations:
${ex}

Recent conversation with ${contactName}:
${hist}

New message(s) from ${contactName} — reply as ${owner}:
${incoming.map(t => `${contactName}: ${t}`).join('\n')}`;
}

/** Remove assistant-isms and enforce the owner's casing habits */
function polish(msgs, o) {
  return msgs
    .map(m => String(m || '').trim())
    .filter(Boolean)
    .map(m => {
      let t = m.replace(/^["“]|["”]$/g, '');
      if (o && o.endsWithPeriod < 15) t = t.replace(/([^.\s])\.$/u, '$1');
      if (o && o.lowercaseStart > 70 && /^\p{Lu}\p{Ll}/u.test(t) && !/^I\b/.test(t)) t = t[0].toLowerCase() + t.slice(1);
      return t;
    })
    .slice(0, 4);
}

/**
 * Generate a reply.
 * @returns {Promise<{action:'reply'|'escalate'|'skip', messages:string[], reason?:string, confidence?:number, examples:number}>}
 */
export async function generateReply({ profile, retriever, contact, history = [], incoming, settings, llm }) {
  const owner = settings.ownerDisplayName || profile?.owner?.[0] || 'Me';
  const contactName = contact?.displayName || contact?.name || 'Them';
  const examples = retriever ? retriever.search(incoming.join('\n'), { contactId: contact?.id, k: settings.examplesK || 8 }) : [];
  const system = buildSystemPrompt({ profile, contact, settings });
  const user = buildUserPrompt({ owner, contactName, examples, history, incoming });

  let raw;
  if (process.env.TWINLY_MOCK === '1') {
    raw = JSON.stringify(examples[0] ? { action: 'reply', messages: examples[0].r, confidence: 0.8 } : { action: 'escalate', reason: 'mock', draft: ['ok'] });
  } else {
    raw = await complete(llm, system, user, { temperature: settings.temperature ?? 0.85 });
  }
  const j = extractJson(raw) || { action: 'reply', messages: [raw] };
  let action = ['reply', 'hold', 'escalate', 'skip', 'react'].includes(j.action) ? j.action : 'reply';
  const msgs = polish(action === 'escalate' ? (j.draft || j.messages || []) : (j.messages || []), profile?.overall);
  if ((action === 'reply' || action === 'hold') && !msgs.length) action = 'skip';
  const emoji = action === 'react' ? (String(j.emoji || '').match(/\p{Extended_Pictographic}[\uFE0F\u200D\p{Extended_Pictographic}]*/u)?.[0] || '👍') : undefined;
  return { action, messages: msgs, emoji, reason: j.reason || '', confidence: j.confidence, examples: examples.length, examplePairs: examples.slice(0, 4) };
}
