// Keeps data/offers.jsonl current without re-downloading it (the full download is ~70 minutes, 963K offers).
// Each run:
//   1. NEW offers: offer ids only grow, so everything above the highest id we hold is new -- paged from there.
//   2. A ROLLING SWEEP: a cursor walks the whole id range, BUDGET requests per run, and the stretch it covers is
//      replaced by what Horizon has now -- offers filled, cancelled or changed since are dropped or updated. At ~400
//      requests a run the whole book is re-read every dozen runs.
// Requests alternate between SDF's and LOBSTR's Horizon, one every GAP_MS overall, which keeps each host near
// 2,400 an hour, under the ~3,600 public limit (an earlier 4-worker run reached 4,800 per host).
//   node update-offers.mjs [budget=400]
import fs from 'node:fs';
const HOSTS = ['https://horizon.stellar.org', 'https://horizon.stellar.lobstr.co'];
const BUDGET = +(process.argv[2] || 400), GAP_MS = +(process.env.GAP || 750);
const OUT = 'data/offers.jsonl', STATE = 'data/sweep-state.json';
const asset = (t, c, i) => (t === 'native' ? 'XLM' : c + '-' + i);
const row = (o) => ({ id: o.id, s: asset(o.selling.asset_type, o.selling.asset_code, o.selling.asset_issuer),
  b: asset(o.buying.asset_type, o.buying.asset_code, o.buying.asset_issuer), a: o.amount, n: o.price_r.n, d: o.price_r.d });
let hostI = 0, reqs = 0, last = 0;
async function page(cursor) {
  const wait = GAP_MS - (Date.now() - last); if (wait > 0) await new Promise((s) => setTimeout(s, wait));
  for (let tries = 0; ; tries++) {
    const h = HOSTS[hostI++ % HOSTS.length]; last = Date.now(); reqs++;
    try {
      const r = await fetch(`${h}/offers?limit=200&order=asc&cursor=${cursor}`);
      if (r.ok) return (await r.json())._embedded.records;
      if (r.status !== 429 && r.status < 500) throw Object.assign(new Error('HTTP ' + r.status), { fatal: 1 });
    } catch (e) { if (e.fatal) throw e; }
    if (tries >= 5) throw new Error('Horizon kept refusing');
    await new Promise((s) => setTimeout(s, 4000 * (tries + 1)));
  }
}
const t0 = Date.now();
const map = new Map();
for (const line of fs.readFileSync(OUT, 'utf8').split('\n')) { if (!line) continue; const o = JSON.parse(line); map.set(o.id, o); }
const before = map.size;
let maxId = 0; for (const id of map.keys()) if (+id > maxId) maxId = +id;
const st = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, 'utf8')) : { cursor: '0' };

// 1. new offers
let added = 0, cur = String(maxId);
for (;;) {
  const recs = await page(cur);
  for (const o of recs) { if (!map.has(o.id)) added++; map.set(o.id, row(o)); cur = o.paging_token; }
  if (recs.length < 200 || reqs >= BUDGET / 2) break;
}
// 2. the rolling sweep: [from, reached] is replaced by what Horizon returned for it
let swept = 0, removed = 0, from = +st.cursor, reached = from, wrapped = false;
const seen = new Set();
while (reqs < BUDGET) {
  const recs = await page(String(reached));
  for (const o of recs) { seen.add(o.id); map.set(o.id, row(o)); reached = +o.paging_token; swept++; }
  if (recs.length < 200) { reached = Infinity; wrapped = true; break; }
}
for (const [id] of map) { const n = +id; if (n > from && n <= reached && !seen.has(id)) { map.delete(id); removed++; } }
st.cursor = wrapped ? '0' : String(reached);
fs.writeFileSync(OUT, [...map.values()].map((o) => JSON.stringify(o)).join('\n') + '\n');
fs.writeFileSync(STATE, JSON.stringify(st));
console.log(`offers ${before} -> ${map.size}: +${added} new, sweep re-read ${swept} (${from} .. ${wrapped ? 'end, wrapping' : reached}), -${removed} gone; ${reqs} requests in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
