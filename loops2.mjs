// Loops that start and end in XLM at a GIVEN AMOUNT, through pools AND order books. A path payment takes, per hop, the
// better of the pool and the order book for that hop's whole amount -- so each hop here is max(pool, book).
//   node loops2.mjs [amount=10] [maxHops=4]
// Inputs: data/pools.json (fetch-pools.mjs) and data/offers.jsonl (fetch-offers.mjs).
import fs from 'node:fs';
const AMOUNT = +(process.argv[2] || 10), MAX = +(process.argv[3] || 4);
const S = 10000000n, INT64_MAX = 9223372036854775807n;
const st = (s) => { const [w, f = ''] = String(s).split('.'); return BigInt(w + f.padEnd(7, '0').slice(0, 7)); };

// edge key "from>to" -> { to, pool: {rin, rout, fee}|null, book: [{a, n, d}] sorted best-first for the taker }
const E = new Map();
const edge = (x, y) => { const k = x + '>' + y; let e = E.get(k); if (!e) { e = { from: x, to: y, pool: null, book: [] }; E.set(k, e); } return e; };
for (const p of JSON.parse(fs.readFileSync('data/pools.json', 'utf8'))) {
  if (!(+p.ra > 0 && +p.rb > 0)) continue;
  edge(p.a, p.b).pool = { rin: st(p.ra), rout: st(p.rb), fee: BigInt(p.fee), id: p.id };
  edge(p.b, p.a).pool = { rin: st(p.rb), rout: st(p.ra), fee: BigInt(p.fee), id: p.id };
}
// An offer SELLS `s` for `b` at n/d (b per s), `a` of s available. A taker going b -> s hits it.
let nOffers = 0; const seen = new Set();
for (const line of fs.readFileSync('data/offers.jsonl', 'utf8').split('\n')) {
  if (!line) continue;
  const o = JSON.parse(line);
  if (seen.has(o.id)) continue;                                    // a stopped fetch can save one page twice
  seen.add(o.id); nOffers++;
  if (o.s === o.b) continue;
  edge(o.b, o.s).book.push({ a: st(o.a), n: BigInt(o.n), d: BigInt(o.d), id: o.id });
}
for (const e of E.values()) if (e.book.length) e.book.sort((p, q) => (p.n * q.d < q.n * p.d ? -1 : p.n * q.d > q.n * p.d ? 1 : 0));

function poolOut(p, x) {
  if (!p || x <= 0n || p.rin + x > INT64_MAX) return 0n;            // the int64 ceiling: see loops.mjs
  const xin = x * (10000n - p.fee);
  return (p.rout * xin) / (p.rin * 10000n + xin);
}
// Walk the book with x of the taker's asset. Each offer: taking all of it costs ceil(a*n/d); the last one partially.
// The protocol crosses at most 1000 offers in one operation; past that the hop fails.
function bookOut(book, x) {
  let left = x, got = 0n, crossed = 0;
  for (const o of book) {
    if (left <= 0n) break;
    if (++crossed > 1000) return 0n;
    const need = (o.a * o.n + o.d - 1n) / o.d;
    if (left >= need) { got += o.a; left -= need; }
    else { got += (left * o.d) / o.n; left = 0n; }
  }
  return left > 0n ? 0n : got;                                       // not enough depth for the whole amount: no fill
}
function hop(e, x) {
  const p = poolOut(e.pool, x), b = e.book.length ? bookOut(e.book, x) : 0n;
  return p >= b ? { out: p, via: 'pool' } : { out: b, via: 'book' };
}
const adj = new Map();
for (const e of E.values()) { if (!adj.has(e.from)) adj.set(e.from, []); adj.get(e.from).push(e); }
const back = new Map(); for (const e of E.values()) if (e.to === 'XLM') back.set(e.from, e);

const start = BigInt(Math.round(AMOUNT * 1e7));
// MINR: keep loops returning at least this share of the input (1 = only profitable). The shortlist keeps near-misses
// too (0.995), because the snapshot is minutes old and the live check decides; a gap closed here may be open now.
const MINR = BigInt(Math.round(+(process.env.MINR || 1) * 1e6));
const hits = []; let evals = 0; const t0 = Date.now();
for (const e1 of adj.get('XLM') || []) {
  const h1 = hop(e1, start); if (!h1.out) continue; const a = e1.to;
  for (const e2 of adj.get(a) || []) {
    const b = e2.to; if (b === 'XLM') {
      // 2 hops: XLM > a > XLM, the same pair both ways (book on one side, pool on the other can disagree)
      evals++; const r = hop(e2, h1.out); if (r.out * 1000000n > start * MINR) hits.push({ ret: r.out, path: [a], via: [h1.via, r.via] });
      continue;
    }
    const h2 = hop(e2, h1.out); if (!h2.out) continue;
    const eb = back.get(b);
    if (eb) { evals++; const r = hop(eb, h2.out); if (r.out * 1000000n > start * MINR) hits.push({ ret: r.out, path: [a, b], via: [h1.via, h2.via, r.via] }); }
    if (MAX < 4) continue;
    for (const e3 of adj.get(b) || []) {
      const c = e3.to; if (c === 'XLM' || c === a) continue;
      const ec = back.get(c); if (!ec) continue;
      const h3 = hop(e3, h2.out); if (!h3.out) continue;
      evals++; const r = hop(ec, h3.out);
      if (r.out * 1000000n > start * MINR) hits.push({ ret: r.out, path: [a, b, c], via: [h1.via, h2.via, h3.via, r.via] });
    }
  }
}
hits.sort((p, q) => (q.ret > p.ret ? 1 : q.ret < p.ret ? -1 : 0));
const short = (s) => s.split('-')[0] + (s.includes('-') ? '-' + s.split('-')[1].slice(0, 4) : '');
console.log(`offers ${nOffers.toLocaleString()}, pairs ${E.size.toLocaleString()}; amount ${AMOUNT} XLM, hops <= ${MAX}: ${evals.toLocaleString()} loops in ${((Date.now() - t0) / 1000).toFixed(1)}s; ${hits.length} return more than ${AMOUNT}`);
for (const h of hits.slice(0, 25)) console.log((Number(h.ret) / 1e7).toFixed(7).padStart(14), ' XLM > ' + h.path.map(short).join(' > ') + ' > XLM   [' + h.via.join(',') + ']');
fs.writeFileSync(process.env.OUTFILE || 'data/hits2.json', JSON.stringify(hits.slice(0, 500).map((h) => ({ ...h, ret: String(h.ret) }))));
