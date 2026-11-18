// Builds data/shortlist-stellar.json: the loops worth re-checking live, at several sizes. Runs loops2.mjs at each amount
// (near-misses included, MINR 0.995), merges by path, keeps the best TOP by their best ratio. The MCP re-checks these at
// the person's own amount against live Horizon; this file only says where to look.
//   node shortlist.mjs
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
const AMOUNTS = [10, 100, 1000], TOP = 150;
const byPath = new Map();
for (const amt of AMOUNTS) {
  const out = `data/hits-${amt}.json`;
  const log = execFileSync(process.execPath, ['--max-old-space-size=6000', 'loops2.mjs', String(amt), '4'],
    { env: { ...process.env, MINR: '0.995', OUTFILE: out }, maxBuffer: 1 << 26 }).toString();
  console.log(log.split('\n')[0]);
  for (const h of JSON.parse(fs.readFileSync(out, 'utf8'))) {
    const k = h.path.join('>');
    const e = byPath.get(k) || { path: h.path, ret: {}, via: {} };
    e.ret[amt] = +(Number(h.ret) / 1e7).toFixed(7); e.via[amt] = h.via;
    byPath.set(k, e);
  }
}
// Each hop's pool id (if the pair has a pool), so the live check reads it in one request instead of searching for it.
const PAIR = new Map(); for (const p of JSON.parse(fs.readFileSync('data/pools.json', 'utf8'))) { PAIR.set(p.a + '|' + p.b, p.id); PAIR.set(p.b + '|' + p.a, p.id); }
for (const e of byPath.values()) { const hops = ['XLM', ...e.path, 'XLM']; e.pools = hops.slice(0, -1).map((x, i) => PAIR.get(x + '|' + hops[i + 1]) || null); }
const loops = [...byPath.values()].map((e) => ({ ...e, best_ratio: Math.max(...Object.entries(e.ret).map(([a, r]) => r / +a)) }))
  .sort((a, b) => b.best_ratio - a.best_ratio).slice(0, TOP);
const body = { chain: 'stellar', at: new Date().toISOString(), amounts: AMOUNTS, note: 'Candidates from a snapshot of pools and order books; re-check live before trusting any of them.', loops };
fs.writeFileSync('data/shortlist-stellar.json', JSON.stringify(body));
console.log(`shortlist: ${loops.length} loops (of ${byPath.size} distinct), ${loops.filter((l) => l.best_ratio > 1).length} above break-even in the snapshot; best ${loops[0] ? loops[0].best_ratio.toFixed(4) : '-'}`);
