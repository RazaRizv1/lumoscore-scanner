// XRP Ledger loops: start and end in a TOKEN (RLUSD by default), at a given amount, through AMM pools and order books.
//
// WHY NOT XRP -> XRP: the ledger rejects an XRP-to-XRP Payment that carries paths (temBAD_SEND_XRP_PATHS), so a loop can
// only be one all-or-nothing transaction when it starts and ends in an issued token -- a Payment to yourself in that
// token, with SendMax in the same token and the loop as its path.
//
// TRANSFER FEES: an issuer can charge a percentage whenever its token moves between two other accounts. A loop that
// ignored it would "find" profit in any token with a fee. Each hop whose input is a token pays its issuer's rate once
// (effective input = x / rate), read from account_info (TransferRate, 1e9 = no fee).
//
// Inputs: data/xrpl-pools.json (fetch-xrpl-pools.mjs). Order books for the most-traded tokens against XRP are read here
// from a public rippled node (book_offers, funded amounts) and cached in data/xrpl-books.json for BOOK_TTL.
//   node xrpl-loops.mjs [amount=10] [maxHops=4]       env: BASE (asset id), MINR, OUTFILE
import fs from 'node:fs';
const AMOUNT = +(process.argv[2] || 10), MAX = +(process.argv[3] || 4);
const BASE = process.env.BASE || '524C555344000000000000000000000000000000.rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De';
const MINR = +(process.env.MINR || 1);
const NODES = ['https://xrplcluster.com', 'https://s1.ripple.com:51234', 'https://s2.ripple.com:51234'];
const BOOK_TOKENS = 80, BOOK_TTL = 20 * 60 * 1000;
async function rpc(method, params) {
  for (let i = 0; i < 6; i++) {
    try {
      const r = await fetch(NODES[i % NODES.length], { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ method, params: [params] }) });
      const j = await r.json(); if (j && j.result && !j.result.error) return j.result;
      if (j && j.result && /actNotFound|noNetwork/.test(j.result.error)) return null;
    } catch (_) {}
    await new Promise((s) => setTimeout(s, 1000 * (i + 1)));
  }
  return null;
}
const cur = (id) => (id === 'XRP' ? { currency: 'XRP' } : { currency: id.split('.')[0], issuer: id.split('.')[1] });
const amt = (v) => (v && typeof v === 'object' ? +v.value : +v / 1e6);
const issuerOf = (id) => (id === 'XRP' ? null : id.split('.')[1]);

const pools = JSON.parse(fs.readFileSync('data/xrpl-pools.json', 'utf8'));
// edges: from -> [{to, pool:{rin, rout, fee}|null, book:[{gets, pays}]}]
const E = new Map();
const edge = (x, y) => { const k = x + '>' + y; if (!E.has(k)) E.set(k, { from: x, to: y, pool: null, book: [] }); return E.get(k); };
for (const p of pools) {
  edge(p.a, p.b).pool = { rin: p.ra, rout: p.rb, fee: p.fee / 100, acct: p.acct };
  edge(p.b, p.a).pool = { rin: p.rb, rout: p.ra, fee: p.fee / 100, acct: p.acct };
}
// Order books: the tokens most traded against XRP, both directions (cached between runs).
let books = null;
if (fs.existsSync('data/xrpl-books.json')) { const c = JSON.parse(fs.readFileSync('data/xrpl-books.json', 'utf8')); if (Date.now() - c.at < BOOK_TTL) books = c.books; }
if (!books) {
  const toks = pools.filter((p) => p.a === 'XRP' || p.b === 'XRP').sort((x, y) => y.vol - x.vol).slice(0, BOOK_TOKENS).map((p) => (p.a === 'XRP' ? p.b : p.a));
  if (!toks.includes(BASE)) toks.push(BASE);
  books = {};
  for (const t of toks) {
    for (const [from, to] of [['XRP', t], [t, 'XRP']]) {
      // We give `from` and get `to`: offers whose TakerGets is `to` and TakerPays is `from`.
      const r = await rpc('book_offers', { taker_gets: cur(to), taker_pays: cur(from), limit: 100, ledger_index: 'validated' });
      books[from + '>' + to] = ((r && r.offers) || []).map((o) => ({ gets: amt(o.taker_gets_funded || o.TakerGets), pays: amt(o.taker_pays_funded || o.TakerPays) }))
        .filter((o) => o.gets > 0 && o.pays > 0);
      await new Promise((s) => setTimeout(s, 250));
    }
  }
  fs.writeFileSync('data/xrpl-books.json', JSON.stringify({ at: Date.now(), books }));
}
for (const [k, b] of Object.entries(books)) { const [x, y] = k.split('>'); if (b.length) edge(x, y).book = b; }

// Transfer rates for every issuer (cached; a rate rarely changes).
const RATES = fs.existsSync('data/xrpl-rates.json') ? JSON.parse(fs.readFileSync('data/xrpl-rates.json', 'utf8')) : {};
const rateOf = (id) => { const i = issuerOf(id); return i && RATES[i] ? RATES[i] : 1; };

function hop(e, x) {
  const xin = x / rateOf(e.from);                        // the token's transfer fee, paid as it moves on
  let p = 0;
  if (e.pool) { const a = xin * (1 - e.pool.fee); p = e.pool.rout * a / (e.pool.rin + a); }
  let left = xin, got = 0;
  for (const o of e.book) { if (left <= 0) break; if (left >= o.pays) { got += o.gets; left -= o.pays; } else { got += o.gets * left / o.pays; left = 0; } }
  const b = left > 1e-12 ? 0 : got;
  return b > p ? { out: b, via: 'book' } : { out: p, via: 'amm' };
}
const adj = new Map(); for (const e of E.values()) { if (!adj.has(e.from)) adj.set(e.from, []); adj.get(e.from).push(e); }
const back = new Map(); for (const e of E.values()) if (e.to === BASE) back.set(e.from, e);
const hits = []; let evals = 0; const t0 = Date.now();
for (const e1 of adj.get(BASE) || []) {
  const h1 = hop(e1, AMOUNT); if (!(h1.out > 0)) continue; const a = e1.to;
  const eb1 = back.get(a);
  if (eb1 && eb1 !== e1) { evals++; const r = hop(eb1, h1.out); if (r.out >= AMOUNT * MINR) hits.push({ ret: r.out, path: [a], via: [h1.via, r.via] }); }
  for (const e2 of adj.get(a) || []) {
    const b = e2.to; if (b === BASE) continue;
    const h2 = hop(e2, h1.out); if (!(h2.out > 0)) continue;
    const eb = back.get(b);
    if (eb) { evals++; const r = hop(eb, h2.out); if (r.out >= AMOUNT * MINR) hits.push({ ret: r.out, path: [a, b], via: [h1.via, h2.via, r.via] }); }
    if (MAX < 4) continue;
    for (const e3 of adj.get(b) || []) {
      const c = e3.to; if (c === BASE || c === a) continue;
      const ec = back.get(c); if (!ec) continue;
      const h3 = hop(e3, h2.out); if (!(h3.out > 0)) continue;
      evals++; const r = hop(ec, h3.out);
      if (r.out >= AMOUNT * MINR) hits.push({ ret: r.out, path: [a, b, c], via: [h1.via, h2.via, h3.via, r.via] });
    }
  }
}
hits.sort((x, y) => y.ret - x.ret);
// Transfer rates for the issuers on the top candidates, then a re-score with them (first run fills the cache).
const need = [...new Set(hits.slice(0, 300).flatMap((h) => h.path.map(issuerOf)).filter((i) => i && !(i in RATES)))];
for (const i of need) { const r = await rpc('account_info', { account: i, ledger_index: 'validated' }); const tr = r && r.account_data && r.account_data.TransferRate; RATES[i] = tr ? tr / 1e9 : 1; await new Promise((s) => setTimeout(s, 150)); }
if (need.length) fs.writeFileSync('data/xrpl-rates.json', JSON.stringify(RATES));
const rescored = hits.slice(0, 300).map((h) => { let x = AMOUNT; const hops = [BASE, ...h.path, BASE]; for (let i = 0; i < hops.length - 1; i++) x = hop(E.get(hops[i] + '>' + hops[i + 1]), x).out; return { ...h, ret: x }; })
  .filter((h) => h.ret >= AMOUNT * MINR).sort((x, y) => y.ret - x.ret);
const short = (s) => (s === 'XRP' ? 'XRP' : (s.split('.')[0].length === 40 ? Buffer.from(s.split('.')[0], 'hex').toString('utf8').replace(/\0/g, '') : s.split('.')[0]));
console.log(`xrpl: pools ${pools.length}, book pairs ${Object.keys(books).length}; base ${short(BASE)} ${AMOUNT}, hops <= ${MAX}: ${evals.toLocaleString()} loops in ${((Date.now() - t0) / 1000).toFixed(1)}s; ${hits.length} before transfer fees, ${rescored.length} after (>= ${MINR})`);
for (const h of rescored.slice(0, 12)) console.log(h.ret.toFixed(6).padStart(14), short(BASE) + ' > ' + h.path.map(short).join(' > ') + ' > ' + short(BASE), '[' + h.via.join(',') + ']');
fs.writeFileSync(process.env.OUTFILE || 'data/xrpl-hits.json', JSON.stringify(rescored.slice(0, 500)));
