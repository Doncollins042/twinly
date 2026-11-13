// Twinly — chat export parser
// Supports: WhatsApp .txt (Android + iOS, 12h/24h, any date order), WhatsApp .zip exports,
// and Telegram Desktop JSON exports (result.json).
import AdmZip from 'adm-zip';
import path from 'node:path';
import crypto from 'node:crypto';

const INVISIBLE = /[‎‏‪-‮⁦-⁩﻿]/g;

// [31/12/2023, 21:15:32] Name: text      (iOS)
// 31/12/2023, 21:15 - Name: text         (Android)
// 12/31/23, 9:15 PM - Name: text         (Android US)
const LINE_RE =
  /^\[?(\d{1,4})[\/.\-](\d{1,2})[\/.\-](\d{1,4}),?\s+(\d{1,2})[:.](\d{2})(?:[:.](\d{2}))?(?:[\s  ]*([AaPp])\.?\s?[Mm]\.?)?\]?\s*(?:[-–]\s*)?(.*)$/;

const MEDIA_RE =
  /^(<media omitted>|<attached:.*>|.*\.(jpg|jpeg|png|webp|opus|mp4|pdf|vcf|docx?) \(file attached\)|(image|video|audio|sticker|gif|document|contact card) omitted|null)$/i;
const DELETED_RE = /^(this message was deleted|you deleted this message|message deleted)\.?$/i;
const SYSTEM_HINT_RE =
  /(end-to-end encrypted|missed (voice|video) call|security code (changed|with)|changed (the|their) (subject|phone|group)|created group|added you|left$|joined using|changed this group|disappearing messages|is a contact|blocked this contact|unblocked this contact)/i;

function cleanText(s) {
  return s.replace(INVISIBLE, '').replace(/\r/g, '').trim();
}

function detectDateOrder(rows) {
  // rows: [a, b, y] numeric date parts (when year is last)
  let firstOver12 = false, secondOver12 = false;
  for (const [a, b] of rows) {
    if (a > 12) firstOver12 = true;
    if (b > 12) secondOver12 = true;
  }
  if (secondOver12 && !firstOver12) return 'MDY';
  if (firstOver12 && !secondOver12) return 'DMY';
  // ambiguous: exports are chronological, so pick the order with fewer backwards jumps
  const back = order => {
    let n = 0, prev = 0;
    for (const [a, b, y] of rows) {
      const [d, m] = order === 'DMY' ? [a, b] : [b, a];
      const v = (y < 100 ? y + 2000 : y) * 400 + m * 32 + d;
      if (v < prev) n++;
      prev = v;
    }
    return n;
  };
  return back('MDY') < back('DMY') ? 'MDY' : 'DMY'; // default — Nigeria/UK/most of the world
}

export function parseWhatsAppText(raw, fileName = 'chat.txt') {
  const lines = raw.replace(INVISIBLE, '').split(/\r?\n/);
  const pre = [];
  for (const line of lines) {
    const m = line.match(LINE_RE);
    if (m && m[8] !== undefined) {
      pre.push({ m, cont: [] });
    } else if (pre.length) {
      pre[pre.length - 1].cont.push(line);
    }
  }
  const yearFirst = pre.some(p => p.m[1].length === 4);
  const order = yearFirst ? 'YMD' : detectDateOrder(pre.slice(0, 6000).map(p => [+p.m[1], +p.m[2], +p.m[3]]));

  const messages = [];
  for (const { m, cont } of pre) {
    let [, p1, p2, p3, hh, mm, ss, ap, rest] = m;
    let y, mo, d;
    if (order === 'YMD') [y, mo, d] = [+p1, +p2, +p3];
    else if (order === 'MDY') [mo, d, y] = [+p1, +p2, +p3];
    else [d, mo, y] = [+p1, +p2, +p3];
    if (y < 100) y += 2000;
    let h = +hh;
    if (ap) {
      const pm = ap.toLowerCase() === 'p';
      if (pm && h < 12) h += 12;
      if (!pm && h === 12) h = 0;
    }
    const ts = new Date(y, mo - 1, d, h, +mm, +(ss || 0)).getTime();
    const colon = rest.indexOf(': ');
    let author = null, text = rest;
    if (colon > 0 && colon < 60) {
      author = cleanText(rest.slice(0, colon));
      text = rest.slice(colon + 2);
    }
    text = cleanText([text, ...cont].join('\n'));
    if (!author) {
      messages.push({ ts, author: null, text, kind: 'system' });
      continue;
    }
    let kind = 'text';
    if (MEDIA_RE.test(text)) kind = 'media';
    else if (DELETED_RE.test(text)) kind = 'deleted';
    else if (/^(missed (voice|video) call|voice call|video call)/i.test(text)) kind = 'call';
    else if (text.includes('<This message was edited>')) text = text.replace(/\s*<This message was edited>/, '');
    messages.push({ ts, author, text, kind });
  }
  return finalizeChat(messages.filter(x => !(x.kind === 'system' && SYSTEM_HINT_RE.test(x.text))), fileName, 'whatsapp');
}

function telegramText(t) {
  if (typeof t === 'string') return t;
  if (Array.isArray(t)) return t.map(p => (typeof p === 'string' ? p : p.text || '')).join('');
  return '';
}

export function parseTelegramJson(raw, fileName = 'result.json') {
  const data = JSON.parse(raw);
  const chats = [];
  const list = data.messages ? [data] : (data.chats?.list || []);
  for (const chat of list) {
    if (!chat.messages) continue;
    const messages = chat.messages
      .filter(m => m.type === 'message')
      .map(m => {
        const text = cleanText(telegramText(m.text));
        const media = !text && (m.photo || m.file || m.media_type);
        return {
          ts: new Date(m.date).getTime(),
          author: m.from || 'Unknown',
          text: text || (media ? '<media>' : ''),
          kind: media ? 'media' : 'text',
        };
      })
      .filter(m => m.text);
    chats.push(finalizeChat(messages, `${fileName} › ${chat.name || 'chat'}`, 'telegram', chat.name));
  }
  return chats;
}

function finalizeChat(messages, fileName, source, title) {
  const counts = {};
  for (const m of messages) if (m.author) counts[m.author] = (counts[m.author] || 0) + 1;
  const participants = Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count }));
  let guessTitle = title;
  if (!guessTitle) {
    const base = path.basename(fileName).replace(/\.(txt|zip|json)$/i, '');
    const wm = base.match(/WhatsApp Chat (?:with|-)\s*(.+)/i);
    guessTitle = wm ? wm[1].trim() : base;
  }
  return {
    id: crypto.createHash('sha1').update(`${source}:${fileName}:${messages.length}:${messages[0]?.ts || 0}:${messages[messages.length - 1]?.ts || 0}`).digest('hex').slice(0, 16),
    source,
    file: fileName,
    title: guessTitle,
    participants,
    isGroup: participants.length > 2,
    messageCount: messages.length,
    first: messages[0]?.ts || null,
    last: messages[messages.length - 1]?.ts || null,
    messages,
  };
}

/** Parse any uploaded buffer → array of chats */
export function parseUpload(buffer, originalName) {
  const name = originalName || 'upload';
  const lower = name.toLowerCase();
  if (lower.endsWith('.zip')) {
    const zip = new AdmZip(buffer);
    const out = [];
    for (const e of zip.getEntries()) {
      if (e.isDirectory) continue;
      const en = e.entryName.toLowerCase();
      if (en.endsWith('.txt')) {
        const chat = parseWhatsAppText(e.getData().toString('utf8'), name.replace(/\.zip$/i, '.txt'));
        if (chat.messageCount) out.push(chat);
      } else if (en.endsWith('.json')) {
        try { out.push(...parseTelegramJson(e.getData().toString('utf8'), e.entryName)); } catch { /* skip */ }
      }
    }
    return out;
  }
  const text = buffer.toString('utf8');
  if (lower.endsWith('.json') || text.trimStart().startsWith('{')) return parseTelegramJson(text, name);
  const chat = parseWhatsAppText(text, name);
  return chat.messageCount ? [chat] : [];
}

/** Name(s) that appear in every chat → most likely the owner */
export function guessOwner(chats) {
  if (!chats.length) return [];
  const tally = {};
  for (const c of chats) for (const p of c.participants) tally[p.name] = (tally[p.name] || 0) + 1;
  const all = Object.entries(tally).sort((a, b) => b[1] - a[1]);
  if (chats.length > 1) {
    const inAll = all.filter(([, n]) => n === chats.length).map(([k]) => k);
    if (inAll.length === 1) return inAll;
  }
  return all.map(([k]) => k);
}
