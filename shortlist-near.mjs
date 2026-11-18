// NEAR (Rhea) loops: start and end in wNEAR, through Rhea's classic constant-product pools, at several sizes, into
// data/shortlist-near.json. One Rhea call runs a list of swap actions and reverts entirely if the last action's
// min_amount_out is not met, so a loop is one all-or-nothing transaction.
//
// Pools: Rhea's own list (indexer.ref.finance/list-top-pools, 2,465 pools). Only SIMPLE_POOL is searched: stable and
// rated pools use different curves, and pricing them with this one would invent numbers. Rhea's math, exactly, in raw
// units: amount_with_fee = in * (10000 - total_fee); out = amount_with_fee * r_out / (10000 * r_in + amount_with_fee).
// The MCP re-checks every candidate with Rhea's own get_return before reporting anything.
//   node shortlist-near.mjs
import fs from 'node:fs';
const BASE = 'wrap.near', AMOUNTS = [1, 10, 100], TOP = 150, MINR = 0.995;
const pools = (await (await fetch('https://indexer.ref.finance/list-top-pools')).json())
  .filter((p) => p.pool_kind === 'SIMPLE_POOL' && p.token_account_ids.length === 2 && p.amounts.every((a) => BigInt(a) > 0n));
const E = new Map();      // "a>b" -> [{id, rin, rout, fee}]
for (const p of pools) {
  const [a, b] = p.token_account_ids, [ra, rb] = p.amounts.map(BigInt), fee = BigInt(p.total_fee);
  for (const [x, y, rx, ry] of [[a, b, ra, rb], [b, a, rb, ra]]) {
    const k = x + '>' + y; if (!E.has(k)) E.set(k, []); E.get(k).push({ id: String(p.id), rin: rx, rout: ry, fee });
  }
}
const out1 = (p, x) => { const w = x * (10000n - p.fee); return w * p.rout / (10000n * p.rin + w); };
const hop = (a, b, x) => { let best = null; for (const p of E.get(a + '>' + b) || []) { const o = out1(p, x); if (!best || o > best.out) best = { out: o, id: p.id }; } return best; };
const adj = new Map(); for (const k of E.keys()) { const [a, b] = k.split('>'); if (!adj.has(a)) adj.set(a, new Set()); adj.get(a).add(b); }
const byPath = new Map(); const t0 = Date.now(); let evals = 0;
for (const amt of AMOUNTS) {
  const start = BigInt(amt) * 10n ** 24n, min = start * BigInt(Math.round(MINR * 1e6)) / 1000000n;
  const keep = (path, ids, ret) => {
    const k = path.join('>'); const e = byPath.get(k) || { path, ret: {}, pools: {} };
    e.ret[amt] = Number(ret * 1000000n / start) / 1e6 * amt; e.pools[amt] = ids; byPath.set(k, e);
  };
  for (const a of adj.get(BASE) || []) {
    const h1 = hop(BASE, a, start); if (!h1 || !h1.out) continue;
    for (const b of adj.get(a) || []) {
      if (b === BASE) continue;
      const h2 = hop(a, b, h1.out); if (!h2 || !h2.out) continue;
      const h3 = hop(b, BASE, h2.out); evals++;
      if (h3 && h3.out >= min) keep([a, b], [h1.id, h2.id, h3.id], h3.out);
      for (const c of adj.get(b) || []) {
        if (c === BASE || c === a) continue;
        const h3b = hop(b, c, h2.out); if (!h3b || !h3b.out) continue;
        const h4 = hop(c, BASE, h3b.out); evals++;
        if (h4 && h4.out >= min) keep([a, b, c], [h1.id, h2.id, h3b.id, h4.id], h4.out);
      }
    }
  }
}
const loops = [...byPath.values()].map((e) => ({ ...e, best_ratio: Math.max(...Object.entries(e.ret).map(([a, r]) => r / +a)) }))
  .sort((a, b) => b.best_ratio - a.best_ratio).slice(0, TOP);
fs.mkdirSync('data', { recursive: true });
fs.writeFileSync('data/shortlist-near.json', JSON.stringify({ chain: 'near', base: BASE, at: new Date().toISOString(), amounts: AMOUNTS,
  note: 'Candidates from a snapshot of Rhea classic pools; re-check live (get_return) before trusting any of them.', loops }));
console.log(`near: ${pools.length} simple pools; ${evals.toLocaleString()} loops in ${((Date.now() - t0) / 1000).toFixed(1)}s; shortlist ${loops.length} (of ${byPath.size}), ${loops.filter((l) => l.best_ratio > 1).length} above break-even; best ${loops[0] ? loops[0].best_ratio.toFixed(4) + ' ' + loops[0].path.join(' > ') : '-'}`);
