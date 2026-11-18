// Builds data/shortlist-xrpl.json: XRP Ledger loops worth re-checking live, starting and ending in RLUSD (see
// xrpl-loops.mjs for why not XRP), at several sizes, near-misses included. The MCP re-checks these live.
//   node shortlist-xrpl.mjs
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
const AMOUNTS = [10, 100, 1000], TOP = 150;
const BASE = process.env.BASE || '524C555344000000000000000000000000000000.rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De';
const byPath = new Map();
for (const amt of AMOUNTS) {
  const out = `data/xrpl-hits-${amt}.json`;
  const log = execFileSync(process.execPath, ['xrpl-loops.mjs', String(amt), '4'],
    { env: { ...process.env, MINR: '0.995', OUTFILE: out, BASE }, maxBuffer: 1 << 26 }).toString();
  console.log(log.split('\n')[0]);
  for (const h of JSON.parse(fs.readFileSync(out, 'utf8'))) {
    const k = h.path.join('>');
    const e = byPath.get(k) || { path: h.path, ret: {}, via: {} };
    e.ret[amt] = +h.ret.toFixed(8); e.via[amt] = h.via; byPath.set(k, e);
  }
}
const loops = [...byPath.values()].map((e) => ({ ...e, best_ratio: Math.max(...Object.entries(e.ret).map(([a, r]) => r / +a)) }))
  .sort((a, b) => b.best_ratio - a.best_ratio).slice(0, TOP);
fs.writeFileSync('data/shortlist-xrpl.json', JSON.stringify({ chain: 'xrpl', base: BASE, at: new Date().toISOString(), amounts: AMOUNTS,
  note: 'Candidates from a snapshot of AMM pools (data by xrpl.to) and order books; re-check live before trusting any of them.', loops }));
console.log(`xrpl shortlist: ${loops.length} loops (of ${byPath.size}), ${loops.filter((l) => l.best_ratio > 1).length} above break-even in the snapshot; best ${loops[0] ? loops[0].best_ratio.toFixed(4) : '-'}`);
