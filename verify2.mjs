// Re-checks loops from data/hits2.json against LIVE Horizon: each hop's pool (by pair) and order book are re-read now and
// the hop takes the better of the two at the actual amount, as a path payment does. Also prints issuer flags.
//   node verify2.mjs [amount=10] [how many distinct loops=8]
import fs from 'node:fs';
const H = 'https://horizon.stellar.org', S = 1e7;
const AMOUNT = +(process.argv[2] || 10), N = +(process.argv[3] || 8);
const hits = JSON.parse(fs.readFileSync('data/hits2.json', 'utf8'));
const pools = JSON.parse(fs.readFileSync('data/pools.json', 'utf8'));
const pairPool = (a, b) => pools.find((p) => (p.a === a && p.b === b) || (p.a === b && p.b === a));
const get = async (p) => { for (let i = 0; i < 4; i++) { const r = await fetch(H + p); if (r.status === 429) { await new Promise((s) => setTimeout(s, 3000)); continue; } return r.json(); } return null; };
const q = (a) => (a === 'XLM' ? 'native' : a.replace('-', ':'));
const qp = (pre, a) => (a === 'XLM' ? `${pre}_asset_type=native` : `${pre}_asset_type=${a.split('-')[0].length <= 4 ? 'credit_alphanum4' : 'credit_alphanum12'}&${pre}_asset_code=${a.split('-')[0]}&${pre}_asset_issuer=${a.split('-')[1]}`);
async function hop(A, B, x) {
  let poolOut = 0;
  const pp = pairPool(A, B);
  if (pp) {
    const p = await get('/liquidity_pools/' + pp.id);
    const rin = +p.reserves.find((r) => r.asset === q(A)).amount, rout = +p.reserves.find((r) => r.asset === q(B)).amount;
    const xin = x * (1 - p.fee_bp / 10000); poolOut = rout * xin / (rin + xin);
  }
  // selling A for B hits the BIDS of the A/B book (amount in B, price B per A)
  const ob = await get(`/order_book?${qp('selling', A)}&${qp('buying', B)}&limit=200`);
  let left = x, got = 0;
  for (const b of (ob && ob.bids) || []) { const pr = +b.price, canA = +b.amount / pr, take = Math.min(left, canA); got += take * pr; left -= take; if (left <= 1e-9) break; }
  const bookOut = left > 1e-7 ? 0 : got;
  const best = bookOut > poolOut ? { out: bookOut, via: 'book' } : { out: poolOut, via: 'pool' };
  const topBid = ob && ob.bids && ob.bids[0] ? `${ob.bids[0].price} x ${(+ob.bids[0].amount).toFixed(4)}` : 'none';
  return { ...best, poolOut, bookOut, topBid };
}
const seen = new Set(); let done = 0;
for (const h of hits) {
  const key = h.path.join('>'); if (seen.has(key)) continue; seen.add(key);
  const hops = ['XLM', ...h.path, 'XLM'];
  let x = AMOUNT; const steps = [];
  for (let i = 0; i < hops.length - 1; i++) { const r = await hop(hops[i], hops[i + 1], x); steps.push(`${hops[i].split('-')[0]}>${hops[i + 1].split('-')[0]} ${r.via} ${r.out.toFixed(7)} (pool ${r.poolOut.toFixed(4)} / book ${r.bookOut.toFixed(4)}, top bid ${r.topBid})`); x = r.out; if (!x) break; }
  console.log(`\n${(+h.ret / S).toFixed(4)} in snapshot -> LIVE ${x.toFixed(7)} XLM  ${hops.map((a) => a.split('-')[0]).join(' > ')}`);
  steps.forEach((s) => console.log('   ' + s));
  if (++done >= N) break;
}
for (const a of ['VELO-GDM4RQUQQUVSKQA7S6EM7XBZP3FCGH4Q7CL6TABQ7B2BEJ5ERARM2M5M', 'yXLM-GARDNV3Q7YGT4AKSDF25LT32YSCCW4EV22Y2TV3I2PU2MMXJTEDL5T55']) {
  const [code, iss] = a.split('-');
  const acc = await get('/accounts/' + iss);
  console.log(`issuer ${code}: flags ${JSON.stringify(acc && acc.flags)} home_domain ${acc && acc.home_domain}`);
}
