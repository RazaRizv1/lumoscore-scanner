// Every XRP Ledger AMM pool into data/xrpl-pools.json, read from xrpl.to's public API (no key: this must not spend the
// key lumoscore.com's Pools page runs on -- going through /lxapi/xrplpools hit that key's 429 after 40 pages).
// XRPL itself has no cheap "list every AMM": ledger_data pages by object type scan a fixed slice of the ledger and filter
// it, so a page returns 0-2 AMMs (measured on three public servers).
// Data by xrpl.to (https://xrpl.to) -- its terms require that credit wherever this data is shown.
//   node fetch-xrpl-pools.mjs
import fs from 'node:fs';
const UP = 'https://api.xrpl.to/api/amm', GAP = +(process.env.GAP || 1500);
const UA = 'lumoscore-scanner (+https://github.com/RazaRizv1/lumoscore-scanner)';
fs.mkdirSync('data', { recursive: true });
const id = (a) => (!a || a.currency === 'XRP' ? 'XRP' : a.currency + '.' + a.issuer);
async function page(n) {
  for (let tries = 0; tries < 6; tries++) {
    try {
      const r = await fetch(`${UP}?limit=100&sort=volume24h&page=${n}`, { headers: { accept: 'application/json', 'user-agent': UA } });
      if (r.ok) return await r.json();
      if (r.status !== 429 && r.status < 500) throw new Error('HTTP ' + r.status);
    } catch (e) { if (/HTTP 4/.test(e.message)) throw e; }
    await new Promise((s) => setTimeout(s, 5000 * (tries + 1)));
  }
  throw new Error('xrpl.to kept refusing at page ' + n);
}
// RESUMABLE: xrpl.to serves 100 pools a page whatever limit is asked (327 pages, ~1.8s each, plus 429 pauses), which
// ran past a 30-minute cap once and saved nothing. Progress is kept every 20 pages and a run continues from it (if it
// is under 6 hours old).
const PROG = 'data/xrpl-pools-progress.json';
const prev = fs.existsSync(PROG) ? JSON.parse(fs.readFileSync(PROG, 'utf8')) : null;
const resume = prev && Date.now() - prev.at < 6 * 3600 * 1000;
const t0 = Date.now(); const pools = resume ? prev.pools : []; let total = Infinity, n = resume ? prev.next : 1;
if (resume) console.log('resuming at page', n, 'with', pools.length, 'pools');
while (n <= total) {
  const d = await page(n);
  total = +d.totalPages || 1;
  for (const p of d.pools || []) {
    const L = p.currentLiquidity || {};
    if (!(+L.asset1Amount > 0) || !(+L.asset2Amount > 0)) continue;
    pools.push({ acct: p.ammAccount, a: id(p.asset1), ra: +L.asset1Amount, b: id(p.asset2), rb: +L.asset2Amount,
      fee: (+p.tradingFee || 0) / 1000, vol: +((p.apy24h || {}).volume) || 0 });        // fee in percent (315 -> 0.315)
  }
  n++;
  if (n % 20 === 0) fs.writeFileSync(PROG, JSON.stringify({ at: resume ? prev.at : t0, next: n, pools }));
  await new Promise((s) => setTimeout(s, GAP));
}
fs.writeFileSync('data/xrpl-pools.json', JSON.stringify(pools));
if (fs.existsSync(PROG)) fs.unlinkSync(PROG);
const assets = new Set(); pools.forEach((p) => { assets.add(p.a); assets.add(p.b); });
console.log(`xrpl pools ${pools.length} (${assets.size} assets), ${pools.filter((p) => p.a === 'XRP' || p.b === 'XRP').length} with XRP; ${n - 1} pages in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
