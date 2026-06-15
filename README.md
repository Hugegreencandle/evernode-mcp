# evernode-mcp — Evernode AI Builder

A [Model Context Protocol](https://modelcontextprotocol.io) server that lets an AI agent **build,
check, cost, and deploy HotPocket dApps** on [Evernode](https://evernode.org) /
[Xahau](https://xahau.network). Point any MCP-capable agent (Claude, etc.) at it and ask for a
dApp — it scaffolds a *deterministic-by-construction* contract, heuristically checks it won't
break cluster consensus, estimates the EVR lease, ranks **live** Evernode hosts, generates the
deploy commands, and — when the dApp moves value on Xahau — hands the settlement Hook off to the
trifecta to be **proven** safe.

> HotPocket is Evernode's contract runtime: it runs your Node.js/WASM contract on **every node**
> of a cluster and puts the output + state through **consensus**. The single biggest beginner
> mistake is non-deterministic code (`Date.now()`, `Math.random()`, `fetch()`, …) — two nodes
> compute different results and the ledger **stalls**. This server is built around catching that.

It is **advisory and read-only**: it generates files + guidance, **never holds keys, never spends
EVR, never acquires a lease, never signs or submits**, and it **connects to** the Offledger
Cluster Manager rather than replacing its orchestration.

## Where it fits — the layer-2 companion to the Hooks trifecta

The Hooks trifecta secures *layer-1* Hooks — **write → simulate one tx → prove all inputs**:

| stage | tool | what it does |
|---|---|---|
| **write** | [xahc](https://github.com/Hugegreencandle/xahc) | author + compile a safe Hook to clean, lint-passed WASM |
| **simulate one** | [xahau-mcp](https://github.com/Hugegreencandle/xahau-mcp) | run the real bytecode against one live transaction |
| **prove all** | [xahc-prover](https://github.com/Hugegreencandle/xahc-prover) | prove an invariant holds for every input in scope — or return the counterexample |

**evernode-mcp** is the *layer-2* companion: it builds the **HotPocket dApps** that run on
Evernode hosts. Whenever a dApp settles value on Xahau through a Hook-guarded account, it hands
off to the trifecta — it never re-asserts settlement safety itself (`check_hook_compat` /
`generate_settlement` emit the trifecta's prove/install commands, not a safety verdict).

## Tools

All ten tools are **read-only / advisory**. Every tool sets `readOnlyHint: true`; only
`recommend_hosts` sets `openWorldHint: true` (the one tool that may reach a live external endpoint,
OnLedger). Each tool publishes an **output schema**, so an agent gets a validated
`structuredContent` shape (not just text) — no guessing field names.

| tool | open world? | returns |
|---|---|---|
| `list_templates` | no | `{ templates }` — the 7 available dApp template names. |
| `generate_contract` | no | `{ template, files, notes }` — a complete, determinism-clean HotPocket file set (contract + state helper + `hp.cfg.override` + `package.json` + client) for a template. |
| `check_determinism` | no | `{ findings, summary }` — **the differentiator.** A heuristic scan of contract source for non-deterministic patterns (wall-clock, randomness, network I/O, env/host reads, timers, unordered iteration) that break cluster consensus. Each finding has `line/column/rule/severity/why/fix`. HIGH findings are likely consensus breakers. Guidance, **not a proof**. |
| `recommend_pattern` | no | `{ pattern, nodes, notes }` — given a plain-English use-case, the HotPocket pattern: node count, state model, oracle/NPL usage, Xahau settlement, and the determinism caveats that matter. |
| `check_hook_compat` | no | `{ involvesHook, workflow, repos }` — when a dApp settles via a Xahau Hook, the exact **write → simulate → prove** handoff to the trifecta (xahc · xahau-mcp · xahc-prover). |
| `generate_settlement` | no | `{ template, limitDrops, files, install, prove, notes }` — cluster-side Xahau payout code + the `install` of the trifecta's PROVEN `agent_guardrail` Hook (per-tx `LIM` + optional `DST` lock) + the exact `xahc prove` command. "Safe by construction → proven safe": the ledger enforces the cap even if the contract/signer is wrong. |
| `estimate_lease_cost` | no | `{ inputs, perNodeEVR, totalEVR, approxDurationHours, notes }` — tenant EVR lease = `evrPerMoment × moments × nodes`. Honest: rates are **host-set** (no network standard); host-side registration fees are excluded. |
| `recommend_hosts` | **yes** | `{ mode, ranked, prefer, note, source?, query? }` — fetch + rank **live** Evernode hosts from [OnLedger](https://api.onledger.net) (real-time from the Xahau registry hook) by `cheap` / `capacity` / `reputation`, with filters (min reputation/slots/RAM, country) — or rank a `hosts` list you supply. **Real data only — never invents hosts**; honest empty + note on fetch failure. |
| `generate_deploy_commands` | no | `{ steps, notes }` — command sequences for `local` (hpdevkit dev cluster) · `single` (evdevkit acquire one host) · `cluster` (evdevkit N-node) · `cluster-manager` (connect to the Offledger Cluster Manager). |
| `explain_error` | no | `{ matched, explanations? / message? }` — map a HotPocket/Evernode error to cause + fix (connection, consensus stall, no hosts, insufficient EVR, lease expiry, docker/Sashimono, Hook rejection). |

## Templates

`generate_contract` ships 7 templates. Each is **deterministic by construction** (no wall-clock,
no randomness, no network in the contract path; time is the consensus ledger seq `ctx.lclSeqNo`;
state persists only through the contract's own consensused state file) and is dogfooded clean
through `check_determinism` (no HIGH findings) by the smoke test and the suite.

| template | what it is | determinism note |
|---|---|---|
| `blank` | minimal echo contract — a starting point. | echoes input + `ctx.lclSeqNo`. |
| `escrow` | depositor locks an amount-claim for a beneficiary, released after a deadline. | deadlines are **ledger sequences**, not timestamps. |
| `subscription` | users subscribe for N ledger-rounds; access granted while `lclSeqNo < expiry`. | pure ledger-seq accounting. |
| `game_backend` | turn-based per-user scores + leaderboard. | leaderboard sorts with a **pubkey tiebreaker** so ordering is deterministic. |
| `voting` | one-vote-per-pubkey poll with tally. | tally iterates a **sorted** key view; votes keyed by pubkey dedupe. |
| `token_gated` | gated access via an admin-maintained allowlist. | **does not read an on-chain balance** from contract logic (non-deterministic) — uses a consensused allowlist/oracle attestation. |
| `payment_splitter` | records deposits, computes weighted splits in integer drops. | remainder to the last recipient so payouts **sum exactly** (no rounding leak); actual payout is a separate Xahau multisig step (see `generate_settlement`). |

Each generated file set carries notes including "before deploy: run `check_determinism` on
`src/index.js` — HIGH findings break consensus."

## Why the determinism check matters (and exactly what it does / doesn't catch)

HotPocket consensuses contract output across **every node**. If two nodes diverge — because you
called `Date.now()`, `Math.random()`, `fetch()`, or read `process.env`, or iterated an unordered
collection built in a non-consensused order — **consensus breaks and the ledger stalls.**
`check_determinism` flags these before you deploy.

It is a **heuristic linter, not a prover** — a source scan (mostly per-line regex, plus a small
cross-line alias pass), so it is *guidance*, never a guarantee. **Design bias (deliberate):** for
this tool a **false-negative** (silently missing a real consensus breaker) is the worst outcome,
so when a construct *could* iterate/serialize an unordered collection but can't be proven sorted,
it is **flagged**. A false-positive (flagging safe code) only costs you a justification.

**Now covered** (each with a `why` + a concrete `fix`):

- **Wall-clock** — `Date.now`, `performance.now`, `process.hrtime[.bigint]`, `new Date()` *(HIGH)*.
- **Randomness** — `Math.random`, `crypto.randomBytes/randomUUID/randomInt/randomFill[Sync]/getRandomValues` *(HIGH)*.
- **Network I/O** — `fetch`/`axios`/`got`/`node-fetch`, `require('https'|'net'|'dns')` *(HIGH)*.
- **Per-node env** — `process.env`/`process.pid`, `os.hostname/networkInterfaces/cpus/freemem/loadavg/uptime/userInfo/platform/arch/tmpdir/endianness` *(HIGH)*.
- **Timers / race** — `setTimeout/setInterval/setImmediate`, `Promise.race/any` *(MEDIUM)*.
- **Filesystem** — `fs.read*/write*/stat/readdir` outside the sanctioned state file *(MEDIUM)*.
- **Unordered iteration** — `for..in`, and `Object.keys/values/entries` + Map/Set `for..of` *(LOW)*. Sorted views (`Object.keys(o).sort()`, `Object.entries(o).sort(...)`) are recognized and **not** flagged.
- **Aliased Map/Set** *(LOW)* — a variable bound to `new Map()`/`new Set()` then iterated / spread / `forEach`'d / `Array.from`'d / `.entries()/.keys()/.values()` on a later line (the cross-line alias pass).
- **Spread / `Array.from` materialization** *(LOW)* — `[...map]`, `[...Object.values(o)]`, `Array.from(set)` that materialize insertion order into an array; suppressed when immediately `.sort()`-ed.
- **`.forEach`** *(LOW)* — over an Object view or `new Map/Set`; suppressed when sorted first.
- **`JSON.stringify` of an unordered object** *(LOW)* — a bare object identifier or a spread/merge whose key order isn't provably consensused (the serialized output/state is consensused byte-for-byte). Fixed-key object **literals**, arrays, primitives, a sorted replacer array, and `.sort()`-ed arguments are recognized as safe and **not** flagged.

**Still out of scope** (documented honestly — these are NOT caught):

- **Floating-point** — no flagging of float math whose rounding / NaN / `-0` behavior could differ across engines.
- **Locale / timezone** — `toLocaleString`, `Intl.*`, `Date` formatting, locale-sensitive `localeCompare`.
- **Deeper data-flow** — order divergence behind multi-hop aliases, function-return values, object spreads merged across several statements, or dynamically-built call expressions. The alias pass covers the *direct* `const x = new Map()` case, not arbitrary data-flow.
- **Known acceptable false-positives** — e.g. `[...Object.keys(o)].sort()` still fires the base `iteration-order` rule (the spread hides the `.sort()` from it); a `Date.now()` used only for a local log; an order-independent reduction over a Map. These flag *safe* code (the acceptable direction) — justify or refactor.

So: it catches the breakers beginners hit, and biases toward over-flagging the iteration/serialize
classes — it does **not** prove determinism. Settlement *safety* is proven separately by the
trifecta (`xahc-prover`). Always test on a real multi-node cluster before mainnet.

## Settlement → the trifecta handoff

When a value-moving dApp (escrow / subscription payout / payment_splitter) pays out on Xahau, it
does so from the **cluster's multisig account**. `generate_settlement` produces the
"safe-by-construction → proven-safe" bundle:

1. **Cluster-side payout code** (`xahau/settle.js`) — the contract decides amounts deterministically *under consensus*; **signing happens OUTSIDE consensus** via the cluster's threshold/multisig signer (no single node holds spend power).
2. **The install** of the trifecta's already-proven, testnet-validated `agent_guardrail` Hook on the cluster account, with your per-tx `LIM` (spend cap, 8-byte big-endian HookParameter) + optional `DST` (destination lock) — emitted as an **unsigned** `xahc install-tx` SetHook to sign offline.
3. **The exact `xahc prove` command** to prove the guardrail invariant on *your* built WASM.

The bundle **emits the prove/install commands — it does not assert a safety verdict itself.** Even
a buggy or compromised signer set cannot exceed the `LIM` or pay a non-allowed `DST`: the ledger
rejects it. Deploy only on a PROVEN verdict from `xahc prove`.

## Install

Install straight from GitHub — it builds on install (the `prepare` script runs `tsc`):

```bash
npm install -g github:Hugegreencandle/evernode-mcp
```

Or clone and build:

```bash
git clone https://github.com/Hugegreencandle/evernode-mcp && cd evernode-mcp
npm install        # `prepare` compiles dist/ automatically
npm run smoke      # offline self-test (templates determinism-clean, checker + math work)
npm test           # the full Vitest suite (offline)
```

Add to an MCP client (e.g. Claude Code / Desktop):

```json
{ "mcpServers": { "evernode": { "command": "evernode-mcp" } } }
```

Or point it directly at the built entry:

```json
{ "mcpServers": { "evernode": { "command": "node", "args": ["/path/to/evernode-mcp/dist/index.js"] } } }
```

## Usage

Point any MCP-capable agent at the server and just ask, e.g.:

- *"Scaffold an escrow HotPocket dApp called `vault`."* → `generate_contract`
- *"Is this contract safe for cluster consensus?"* (paste source) → `check_determinism`
- *"What pattern should I use for a token-gated forum?"* → `recommend_pattern`
- *"Find me the 5 cheapest active Evernode hosts in Germany."* → `recommend_hosts` (live)
- *"Estimate the EVR to run a 3-node cluster for 720 moments at 2 EVR/moment."* → `estimate_lease_cost`
- *"Generate the safe Xahau settlement for my splitter, capped at 50 XAH."* → `generate_settlement` → then run the emitted `xahc prove` command.

## Dev / test / CI

```bash
npm run build      # tsc → dist/
npm test           # build + Vitest (offline; mocks the live OnLedger fetch)
npm run smoke      # node dist/index.js --smoke — offline self-test
node dist/index.js # run as a stdio MCP server
```

- **Tests** (`tests/`): `determinism` (rule coverage incl. the regression floor + new gaps), `advisor` (lease math, host ranking, error mapping, pattern/deploy branches), `templates` (per-template build + determinism-clean), `settlement` (LIM encoding + trifecta handoff shape), `outputSchemas` (each handler's real output validates against its published schema), `index` (end-to-end: every tool driven through an in-memory MCP client, input-schema rejection), and `fetch` (live-path hardening, mocked).
- **CI** (`.github/workflows/ci.yml`): on push + PR to `main`, runs `npm ci`, `npm run build`, `npm test`, and `npm run smoke` on Node 20.
- **`createServer()`** is exported from `src/index.ts` so the server can be driven over an in-memory transport in tests without starting the stdio transport.

## Honest scope (recap)

- Generates code + guidance; **does not** acquire leases, sign, or move EVR/XAH. No key custody.
- `recommend_hosts` fetches **live** from OnLedger (or ranks a list you supply) — it never fabricates host addresses/specs; on fetch failure it returns empty hosts + a note explaining why, never a fabricated fallback.
- `check_determinism` is a **heuristic** source scan — guidance, not a proof; biased to over-flag the iteration/serialize classes; test on a real multi-node cluster before mainnet.
- Settlement safety (Hook spend limits) is **delegated to the trifecta**, which *proves* it — this server emits the prove/install commands, never a verdict.

## License

**MIT © 2026 Dane Brown.** Open source; see [LICENSE](LICENSE). Not affiliated with Evernode Labs
or the Xahau project. `check_determinism` findings are heuristic guidance, not a guarantee — always
test on a multi-node cluster and review before mainnet.
