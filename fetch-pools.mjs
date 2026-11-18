// Pulls every Stellar liquidity pool from Horizon into data/pools.json, and reports the shape of the graph:
// how many pools have real reserves, how many assets they connect, and how many touch XLM.
import fs from 'node:fs';
const H = process.env.HORIZON || 'https://horizon.stellar.org';
fs.mkdirSync('data', { recursive: true });
const asset = (s) => (s === 'native' ? 'XLM' : s.replace(':', '-'));
let url = H + '/liquidity_pools?limit=200&order=asc', pages = 0;
const pools = [];
const t0 = Date.now();
while (url) {
  const r = await fetch(url);
  if (!r.ok) { console.log('HTTP', r.status, 'on page', pages); if (r.status === 429) { await new Promise((s) => setTimeout(s, 5000)); continue; } break; }
  const j = await r.json();
  const recs = j._embedded.records;
  pages++;
  for (const p of recs) {
    if (p.reserves.length !== 2) continue;
    pools.push({ id: p.id, fee: p.fee_bp, a: asset(p.reserves[0].asset), ra: p.reserves[0].amount, b: asset(p.reserves[1].asset), rb: p.reserves[1].amount });
  }
  url = recs.length === 200 ? j._links.next.href : null;
}
fs.writeFileSync('data/pools.json', JSON.stringify(pools));
const live = pools.filter((p) => +p.ra > 0 && +p.rb > 0);
const assets = new Set(); live.forEach((p) => { assets.add(p.a); assets.add(p.b); });
const xlm = live.filter((p) => p.a === 'XLM' || p.b === 'XLM');
console.log(`pages ${pages} in ${((Date.now() - t0) / 1000).toFixed(1)}s; pools ${pools.length}; with both reserves > 0: ${live.length}; assets ${assets.size}; XLM pools ${xlm.length}; fees ${[...new Set(pools.map((p) => p.fee))]}`);
