# evernode-mcp — Evernode AI Builder

An [MCP](https://modelcontextprotocol.io) server that helps an AI agent **build, check, cost,
and deploy HotPocket dApps** on [Evernode](https://evernode.org) / [Xahau](https://xahau.network).
Point any MCP-capable agent at it and ask for a dApp — it scaffolds a deterministic contract,
checks it won't break cluster consensus, estimates the EVR lease, ranks hosts, and generates
the deploy commands.

It is **advisory and read-only**: it generates files + guidance, never holds keys, never spends
EVR, and **connects to** the Offledger Cluster Manager rather than replacing it.

## Where it fits

The Hooks trifecta secures *layer-1* Hooks: write ([xahc](https://github.com/Hugegreencandle/xahc))
→ simulate ([xahau-mcp](https://github.com/Hugegreencandle/xahau-mcp)) → prove
([xahc-prover](https://github.com/Hugegreencandle/xahc-prover)). **evernode-mcp** is the *layer-2*
companion: it builds the **HotPocket dApps** that run on Evernode hosts, and hands off to the
trifecta whenever a dApp settles value on Xahau through a Hook-guarded account.

## Tools

| tool | does |
|---|---|
| `list_templates` | the available dApp templates |
| `generate_contract` | scaffold a deterministic HotPocket dApp (escrow · subscription · game_backend · voting · token_gated · payment_splitter · blank) |
| `check_determinism` | **the differentiator** — scan a contract for non-deterministic code (wall-clock, randomness, network, env, timers) that breaks consensus |
| `recommend_pattern` | which HotPocket pattern fits a use-case (node count, NPL/oracle, Xahau settlement) |
| `check_hook_compat` | when a dApp settles via a Xahau Hook, the exact write→simulate→prove handoff to the trifecta |
| `estimate_lease_cost` | tenant EVR lease = evrPerMoment × moments × nodes (honest about host-set rates) |
| `recommend_hosts` | **fetch + rank live hosts** from OnLedger (api.onledger.net, real-time from the Xahau registry) by cheap/capacity/reputation, with filters (min rep/slots/RAM, country) — or rank a list you supply. Real data only |
| `generate_deploy_commands` | command sequences for local · single · cluster · Cluster-Manager deploys |
| `explain_error` | map a HotPocket/Evernode error to cause + fix |

## Why the determinism check matters

HotPocket runs your contract on **every node** of the cluster and consensuses the output. If two
nodes compute different results — because you called `Date.now()`, `Math.random()`, `fetch()`,
or read `process.env` — **consensus breaks and the ledger stalls**. It's the #1 HotPocket
mistake. `check_determinism` flags these before you deploy; every shipped template is checked
clean by the heuristic scanner (no HIGH findings). Time is the consensus ledger seq
(`ctx.lclSeqNo`); external data must enter as a consensused input or via an oracle/NPL agreement.

It is a **heuristic linter, not a prover** — a regex source scan that catches the *common*
consensus-breakers (wall-clock incl. `process.hrtime[.bigint]`, randomness incl.
`crypto.randomInt`/`randomFill`, network I/O, `process.env`/`os.*`, timers, `for..in`, and
unsorted `Object.keys/values/entries` + Map/Set iteration). It does **not** prove determinism
and has known out-of-scope classes:
- **Floating-point** — no flagging of float math whose rounding/NaN/`-0` behavior could differ.
- **Locale / timezone** — `toLocaleString`, `Intl.*`, `Date` formatting, locale-sensitive
  `localeCompare` are not flagged.
- **Iteration order it can't see** — order divergence behind aliases (`const ks = Object.keys(o); …`
  used elsewhere), spreads (`[...map]`), `Array.from(set)`, `.forEach` over a Map/Set, or
  `JSON.stringify` of an object built in a non-consensused order. Sorted iteration
  (`Object.keys(o).sort()`, `Object.entries(o).sort(...)`) is recognized and *not* flagged.

So: it catches the breakers beginners hit, not all of them. Settlement *safety* is proven
separately by the trifecta (`xahc-prover`).

## Quickstart

```sh
npm install && npm run build
npm run smoke          # self-test (templates are determinism-clean, checker works)
node dist/index.js     # run as an MCP server on stdio
```

Add to an MCP client (e.g. Claude) as a stdio server pointing at `dist/index.js`.

## Honest scope
- Generates code + guidance; **does not** acquire leases, sign, or move EVR/XAH.
- `recommend_hosts` fetches live from OnLedger (or ranks a list you supply) — it never fabricates host addresses/specs; honest on fetch failure.
- `check_determinism` is a **heuristic** source scan — guidance, not a proof; test on a real
  multi-node cluster before mainnet.
- Settlement safety (Hook spend limits) is delegated to the trifecta, which *proves* it.

**MIT License — © 2026 Dane Brown.** Open source; see [LICENSE](LICENSE). Not affiliated with
Evernode Labs or the Xahau project.
