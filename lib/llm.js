// Twinly — provider-agnostic LLM client (Anthropic Claude, OpenAI, Google Gemini)

export const PROVIDERS = {
  anthropic: { label: 'Anthropic Claude', defaultModel: 'claude-sonnet-5-5' },
  openai: { label: 'OpenAI', defaultModel: 'gpt-4.1-mini' },
  gemini: { label: 'Google Gemini', defaultModel: 'gemini-2.5-flash' },
};

async function post(url, headers, body, timeoutMs = 45000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal: ctrl.signal });
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch { json = null; }
    if (!res.ok) throw new Error(`${res.status} ${json?.error?.message || json?.error?.type || text.slice(0, 200)}`);
    return json;
  } finally { clearTimeout(t); }
}

/**
 * @param {{provider:string, model?:string, apiKey:string}} cfg
 * @param {string} system
 * @param {string} user
 */
export async function complete(cfg, system, user, { maxTokens = 700, temperature = 0.85 } = {}) {
  const provider = cfg.provider || 'anthropic';
  const model = cfg.model || PROVIDERS[provider]?.defaultModel;
  if (!cfg.apiKey) throw new Error('No AI API key set — add one in Settings.');

  if (provider === 'anthropic') {
    const j = await post('https://api.anthropic.com/v1/messages',
      { 'x-api-key': cfg.apiKey, 'anthropic-version': '2023-06-01' },
      { model, max_tokens: maxTokens, temperature, system, messages: [{ role: 'user', content: user }] });
    return (j.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  }
  if (provider === 'openai') {
    const body = { model, temperature, max_completion_tokens: maxTokens, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] };
    const call = b => post('https://api.openai.com/v1/chat/completions', { authorization: `Bearer ${cfg.apiKey}` }, b);
    let j;
    try { j = await call(body); } catch (e) {
      if (!/temperature|response_format/i.test(e.message)) throw e;   // some reasoning models only allow defaults
      const { temperature: _t, response_format: _r, ...rest } = body;
      j = await call({ ...rest, max_completion_tokens: Math.max(maxTokens, 2000) });
    }
    return j.choices?.[0]?.message?.content || '';
  }
  if (provider === 'gemini') {
    const j = await post(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(cfg.apiKey)}`, {},
      { systemInstruction: { parts: [{ text: system }] }, contents: [{ role: 'user', parts: [{ text: user }] }], generationConfig: { temperature, maxOutputTokens: maxTokens, responseMimeType: 'application/json' } });
    return j.candidates?.[0]?.content?.parts?.map(p => p.text).join('') || '';
  }
  throw new Error(`Unknown provider: ${provider}`);
}

/** Pull the first JSON object out of a model response */
export function extractJson(text) {
  const s = String(text || '').replace(/```(?:json)?/gi, '');
  const start = s.indexOf('{');
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) { try { return JSON.parse(s.slice(start, i + 1)); } catch { return null; } }
  }
  return null;
}
