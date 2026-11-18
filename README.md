# lumoscore-scanner

Scheduled scanner behind the LumosCore MCP's `find_arbitrage` tool.

Every 30 minutes a GitHub Action reads every Stellar liquidity pool and open offer, searches every loop of up to four
hops that starts and ends in XLM at 10, 100 and 1,000 XLM, and publishes a shortlist of candidates to the `shortlist`
branch (`shortlist-stellar.json`).

The shortlist is **not** a list of opportunities. It comes from a snapshot that is minutes to hours old, and on
Stellar real price gaps close within minutes. The MCP re-reads every candidate's pools and order books live, at the
person's own amount, and reports only loops that still return more than they cost at that moment. Most of the time
the honest answer is that none do.

- `fetch-pools.mjs` – all pools from Horizon.
- `fetch-offers.mjs` – the full offer book (first run only, ~70 minutes).
- `update-offers.mjs` – new offers plus a rolling re-sync of old ones, about 400 requests a run.
- `loops2.mjs` – the loop search: pools and order books, exact stroop arithmetic, the int64 reserve ceiling.
- `shortlist.mjs` – runs the search at several amounts and writes the shortlist.

Requests alternate between two public Horizon servers and stay under about 2,400 an hour per host.
