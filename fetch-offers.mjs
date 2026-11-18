// Pulls every open Stellar offer into data/offers.jsonl, in parallel slices of the offer-id range, alternating between
// two public Horizons so neither sees more than ~2,400 requests an hour (their limit is ~3,600 per IP). Resumable: each
// slice's cursor is kept in data/offers-state.json, so a rerun continues where it stopped.
//   node fetch-offers.mjs [workers=4]
import fs from 'node:fs';
const HOSTS = ['https://horizon.stellar.org', 'https://horizon.stellar.lobstr.co'];
const WORKERS = +(process.argv[2] || 4);
// Per worker, at most one request every GAP ms. Workers alternate hosts, so per host: (WORKERS/2) * 3600000/GAP an hour.
// 4 workers at 3000ms = 2,400/hour per host. (1500ms was 4,800/hour per host -- over the ~3,600 public limit.)
const MIN_GAP_MS = +(process.env.GAP || 3000);
fs.mkdirSync('data', { recursive: true });
const asset = (t, c, i) => (t === 'native' ? 'XLM' : c + '-' + i);
const STATE = 'data/offers-state.json', OUT = 'data/offers.jsonl';
const get = async (url) => {
  for (let tries = 0; ; tries++) {
    try {
      const r = await fetch(url);
      if (r.status === 429 || r.status >= 500) throw new Error('HTTP ' + r.status);
      if (!r.ok) throw Object.assign(new Error('HTTP ' + r.status), { fatal: true });
      return await r.json();
    } catch (e) {
      if (e.fatal || tries >= 5) throw e;
      await new Promise((s) => setTimeout(s, 5000 * (tries + 1)));
    }
  }
};
// The id range, from the newest offer, cut into slices.
const top = +(await get(HOSTS[0] + '/offers?limit=1&order=desc'))._embedded.records[0].id;
const SLICES = 64;
let state = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, 'utf8')) : null;
// A run that was stopped leaves its in-progress slices marked busy; they are free again now.
if (state) state.slices.forEach((x) => delete x.busy);
if (!state) {
  state = { top, slices: [] };
  for (let i = 0; i < SLICES; i++) state.slices.push({ from: Math.floor(top * i / SLICES), to: Math.floor(top * (i + 1) / SLICES), cursor: String(Math.floor(top * i / SLICES)), done: false, n: 0 });
  fs.writeFileSync(OUT, '');
}
const saveState = () => fs.writeFileSync(STATE, JSON.stringify(state));
let reqs = 0, offers = state.slices.reduce((s, x) => s + x.n, 0);
const t0 = Date.now();
async function worker(w) {
  const host = HOSTS[w % HOSTS.length];
  for (;;) {
    const sl = state.slices.find((x) => !x.done && !x.busy);
    if (!sl) return;
    sl.busy = true;
    while (!sl.done) {
      const t = Date.now();
      const j = await get(`${host}/offers?limit=200&order=asc&cursor=${sl.cursor}`);
      reqs++;
      const recs = j._embedded.records;
      const lines = [];
      for (const o of recs) {
        if (+o.id >= sl.to) { sl.done = true; break; }
        lines.push(JSON.stringify({ id: o.id, s: asset(o.selling.asset_type, o.selling.asset_code, o.selling.asset_issuer), b: asset(o.buying.asset_type, o.buying.asset_code, o.buying.asset_issuer), a: o.amount, n: o.price_r.n, d: o.price_r.d }));
        sl.cursor = o.paging_token;
      }
      if (lines.length) { fs.appendFileSync(OUT, lines.join('\n') + '\n'); sl.n += lines.length; offers += lines.length; }
      if (recs.length < 200) sl.done = true;
      saveState();
      const wait = MIN_GAP_MS - (Date.now() - t);
      if (wait > 0) await new Promise((s) => setTimeout(s, wait));
    }
    delete sl.busy;
  }
}
const tick = setInterval(() => {
  const done = state.slices.filter((x) => x.done).length;
  console.log(`${new Date().toISOString().slice(11, 19)} slices ${done}/${SLICES}, offers ${offers}, requests ${reqs}, ${((Date.now() - t0) / 60000).toFixed(1)} min`);
}, 30000);
await Promise.all(Array.from({ length: WORKERS }, (_, w) => worker(w)));
clearInterval(tick);
state.slices.forEach((x) => delete x.busy); saveState();
console.log(`DONE offers ${offers} requests ${reqs} in ${((Date.now() - t0) / 60000).toFixed(1)} min`);
