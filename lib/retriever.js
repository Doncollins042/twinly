// Twinly — finds the owner's real past replies to messages similar to the incoming one (BM25).
import { tokenize } from './analyzer.js';

export class Retriever {
  constructor(pairs = []) { this.build(pairs); }

  build(pairs) {
    this.pairs = pairs;
    this.docs = pairs.map(p => tokenize(p.p));
    this.df = new Map();
    let total = 0;
    for (const d of this.docs) {
      total += d.length;
      for (const t of new Set(d)) this.df.set(t, (this.df.get(t) || 0) + 1);
    }
    this.avgLen = this.docs.length ? total / this.docs.length : 1;
    this.N = this.docs.length;
  }

  /** @returns top-k pairs; same-contact pairs are boosted, recent pairs slightly boosted */
  search(text, { contactId, k = 6 } = {}) {
    if (!this.N) return [];
    const q = [...new Set(tokenize(text))];
    const k1 = 1.4, b = 0.7;
    const scored = [];
    for (let i = 0; i < this.N; i++) {
      const d = this.docs[i];
      if (!d.length) continue;
      let s = 0;
      for (const t of q) {
        const df = this.df.get(t);
        if (!df) continue;
        let tf = 0;
        for (const w of d) if (w === t) tf++;
        if (!tf) continue;
        const idf = Math.log(1 + (this.N - df + 0.5) / (df + 0.5));
        s += idf * ((tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * d.length) / this.avgLen)));
      }
      if (s <= 0) continue;
      if (contactId && this.pairs[i].c === contactId) s *= 1.6;
      s *= 1 + (i / this.N) * 0.15;
      scored.push([s, i]);
    }
    scored.sort((a, b) => b[0] - a[0]);
    const out = [], seen = new Set();
    for (const [, i] of scored) {
      const key = this.pairs[i].r.join('|');
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(this.pairs[i]);
      if (out.length >= k) break;
    }
    // pad with recent same-contact pairs so tone with this person is always represented
    if (contactId && out.length < k) {
      for (let i = this.N - 1; i >= 0 && out.length < k; i--) {
        const p = this.pairs[i];
        if (p.c === contactId && !out.includes(p)) out.push(p);
      }
    }
    return out;
  }
}
