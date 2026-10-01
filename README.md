# evernode-mcp — Evernode AI Builder

A [Model Context Protocol](https://modelcontextprotocol.io) server that lets an AI agent **build,
check, cost, and deploy HotPocket dApps** on [Evernode](https://evernode.org) /
[Xahau](https://xahau.network). Point any MCP-capable agent (Claude, etc.) at it and ask for a
dApp — it scaffolds a contract from templates written to avoid the known consensus-breakers,
lints contract code for non-deterministic patterns, estimates the EVR lease, ranks **live**
Evernode hosts, generates the deploy commands, and — when the dApp moves value on Xahau — emits
the commands to install a spend-limit Hook and prove its invariant with the Hooks toolchain.

> HotPocket is Evernode's contract runtime: it runs your Node.js/WASM contract on **every node**
> of a cluster and puts the output + state through **consensus**. The single biggest beginner
> mistake is non-deterministic code (`Date.now()`, `Math.random()`, `fetch()`, …) — two nodes
> compute different results and the ledger **stalls**. This server is built around catching the
> common causes of that before deploy (heuristically — see [what it does / doesn't catch](#why-the-determinism-check-matters-and-exactly-what-it-does--doesnt-catch)).

It is **advisory and read-only**: it generates files + guidance, **never holds keys, never spends
EVR, never acquires a lease, never signs or submits**, and it **connects to** the Offledger
Cluster Manager rather than replacing its orchestration. No API keys or accounts are needed; the
only network calls are read-only HTTPS GETs to the public OnLedger API from two tools (see
[Network access](#network-access)).

## Where it fits — the layer-2 companion to the Hooks trifecta

The Hooks pipeline secures *layer-1* Hooks — **write → simulate one tx → prove all inputs → watch live**:

| stage | tool | what it does |
|---|---|---|
| **write** | [xahc](https://github.com/Hugegreencandle/xahc) | author + compile a safe Hook to clean, lint-passed WASM |
| **simulate one** | [xahau-mcp](https://github.com/Hugegreencandle/xahau-mcp) | run the real bytecode against one live transaction |
| **prove all** | [xahc-prover](https://github.com/Hugegreencandle/xahc-prover) | prove an invariant holds for every input in scope — or return the counterexample |
| **watch live** | [xahc-watch](https://github.com/Hugegreencandle/xahc-prover/tree/main/src/watch) | bind a proof to the deployed hook and continuously attest it (alerts on a `SetHook` swap or a live verdict break) |

**evernode-mcp** is the *layer-2* companion: it builds the **HotPocket dApps** that run on
Evernode hosts. Whenever a dApp settles value on Xahau through a Hook-guarded account, it hands
off to the trifecta — it never re-asserts settlement safety itself (`check_hook_compat` /
`generate_settlement` emit the trifecta's prove/install commands, not a safety verdict).

## Tools

All twelve tools are **read-only / advisory**. Every tool sets `readOnlyHint: true`; only the two
live OnLedger tools (`recommend_hosts`, `host_diagnostics`) set `openWorldHint: true` (they may reach
a live external endpoint, OnLedger). Each tool publishes an **output schema**, so an agent gets a
validated `structuredContent` shape (not just text) — no guessing field names.

| tool | open world? | returns |
|---|---|---|
| `list_templates` | no | `{ templates }` — the 10 available dApp template names. |
| `generate_contract` | no | `{ template, files, notes }` — a complete, lint-clean (no HIGH `check_determinism` findings) HotPocket file set (contract + state helper + `hp.cfg.override` + `package.json` + client) for a template. |
| `check_determinism` | no | `{ findings, summary }` — a heuristic linter for contract source: flags known non-deterministic patterns (wall-clock, randomness, network I/O, env/host reads, timers/races, filesystem outside the state file, unordered iteration/serialization, locale/timezone formatting, floating-point literals) that can break cluster consensus. Each finding has `line/column/rule/severity/why/fix`. HIGH findings are likely consensus breakers. A clean result means none of these patterns were found — **not** that the contract is proven deterministic. |
| `check_contract_api` | no | `{ findings, summary }` — **sibling to `check_determinism`** (same honest framing — guidance, **not a proof**). A heuristic static check that a HotPocket Node.js contract uses the contract API correctly: an `hpc.init(...)` entry point, reading `ctx` (`users`/`lclSeqNo`), persisting ONLY through the consensused state mechanism (no arbitrary `fs` writes to non-state paths), handling `ctx.users` I/O, using `ctx.lclSeqNo` for time (not `Date.now`), and awaiting async consensus ops. Each finding has `line/column/rule/severity/why/fix`. |
| `recommend_pattern` | no | `{ pattern, nodes, notes }` — given a plain-English use-case, the HotPocket pattern: node count, state model, oracle/NPL usage, Xahau settlement, and the determinism caveats that matter. |
| `check_hook_compat` | no | `{ involvesHook, workflow, repos }` — returns the recommended **write → simulate → prove → install** workflow for a dApp that settles via a Xahau Hook (xahc · xahau-mcp · xahc-prover). It does not analyze a Hook itself. |
| `generate_settlement` | no | `{ template, limitDrops, files, install, prove, notes }` — starter cluster-side Xahau payout code + an unsigned `xahc install-tx` command for the `agent_guardrail` Hook (per-tx `LIM` + optional `DST` lock) + the `xahc prove` command to check it. Emits commands only, no safety verdict. Accepts `escrow` / `subscription` / `payment_splitter` / `streaming_payment` / `multisig_treasury`. |
| `estimate_lease_cost` | no | `{ inputs, perNodeEVR, totalEVR, approxDurationHours, notes }` — tenant EVR lease = `evrPerMoment × moments × nodes`. Honest: rates are **host-set** (no network standard); host-side registration fees are excluded. |
| `recommend_hosts` | **yes** | `{ mode, ranked, prefer, note, source?, query? }` — fetch + rank **live** Evernode hosts from the public [OnLedger](https://api.onledger.net) API (an index of the Evernode registry on Xahau) by `cheap` / `capacity` / `reputation`, with filters (min reputation/slots/RAM, country) passed to the live query — or rank a `hosts` list you supply (filters not applied; top 10). **Real data only — never invents hosts**; honest empty + note on fetch failure. |
| `host_diagnostics` | **yes** | `{ found, address, source, note?, registration?, reputation?, slots?, lease?, specs?, redFlags }` — health view of a single Evernode host by r-address: registration status, reputation, active/total/available slots, lease terms (rate/drops if available), specs, and red-flags (flagged, marked inactive, low or zero reputation, full capacity). Fetches **live** from OnLedger — or diagnose a `host` object you supply. **Real data only**: numeric fields are **soundly coerced** (a string-typed numeric like `"252"` becomes a real number; garbage / non-finite values are **omitted**, never a fabricated `0`); unknown fields are **omitted** (never invented); honest `found:false` + note on not-found / fetch failure. |
| `generate_deploy_commands` | no | `{ steps, notes }` — command sequences for `local` (hpdevkit dev cluster) · `single` (evdevkit acquire one host) · `cluster` (evdevkit N-node) · `cluster-manager` (connect to the Offledger Cluster Manager). |
| `explain_error` | no | `{ matched, explanations? / message? }` — map a HotPocket/Evernode error to cause + fix (connection, consensus stall, no hosts, insufficient EVR, lease expiry, docker/Sashimono, Hook rejection). |

## Templates

`generate_contract` ships 10 templates. Each is written to avoid the known non-determinism
sources (no wall-clock, no randomness, no network in the contract path; time is the consensus
ledger seq `ctx.lclSeqNo`; state persists only through the contract's own consensused state file)
and is **lint-clean**: the smoke test and the suite run every template through `check_determinism`
(no HIGH findings) and `check_contract_api`. That is a heuristic check, not a proof of
determinism — test on a multi-node cluster before mainnet.

| template | what it is | determinism note |
|---|---|---|
| `blank` | minimal echo contract — a starting point. | echoes input + `ctx.lclSeqNo`. |
| `escrow` | depositor locks an amount-claim for a beneficiary, released after a deadline. | deadlines are **ledger sequences**, not timestamps. |
| `subscription` | users subscribe for N ledger-rounds; access granted while `lclSeqNo < expiry`. | pure ledger-seq accounting. |
| `game_backend` | turn-based per-user scores + leaderboard. | leaderboard sorts with a **code-point** pubkey tiebreaker (not `localeCompare` — host ICU collation diverges) so ordering is deterministic. |
| `voting` | one-vote-per-pubkey poll with tally. | tally iterates a **sorted** key view; votes keyed by pubkey dedupe. |
| `token_gated` | gated access via an admin-maintained allowlist. | **does not read an on-chain balance** from contract logic (non-deterministic) — uses a consensused allowlist/oracle attestation. |
| `payment_splitter` | records deposits, computes weighted splits in integer drops. | remainder to the last recipient so payouts **sum exactly** (no rounding leak); actual payout is a separate Xahau multisig step (see `generate_settlement`). |
| `oracle_consumer` | the canonical hard pattern: brings external data in via **NPL agreement** (nodes agree on the value before acting), never a direct fetch. | nodes PROPOSE their observation over the Node Party Line and only ACT on a strict-majority **agreed** value (a primitive, so its canonical form is byte-identical); disagreement is a deterministic no-op; the agreed datum is stamped with `ctx.lclSeqNo`. |
| `streaming_payment` | per-ledger-seq vesting: releasable amount is `release = f(ctx.lclSeqNo)`. | pure function of the consensus clock, integer drops only (no float divergence); the contract RECORDS the release — the actual transfer is **deferred** to `generate_settlement`. |
| `multisig_treasury` | records spend proposals + M-of-N approvals (threshold). | approvals keyed by signer pubkey, counted over a **sorted** view; on reaching the threshold it **emits the settlement step** to `generate_settlement` (ties the trifecta in) — the contract never signs/spends. |

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
- **Aliased Map/Set** *(LOW)* — a variable **or a member** (`this.m = new Map()`, `state.m = new Set()`) bound to `new Map()`/`new Set()` then iterated / spread / `forEach`'d / `Array.from`'d / `.entries()/.keys()/.values()` on a later line (the cross-line alias pass — now covers member-expression aliases, not just plain identifiers).
- **Member-expression `for..of`** *(LOW)* — `for (const x of this.m / state.m / obj.m)` even with **no** Map/Set evidence: order-unprovable, so flagged. Known deterministic array members (`user.inputs`/`outputs`) and **call** expressions (`ctx.users.list()`) are recognized and **not** flagged.
- **Spread / `Array.from` materialization** *(LOW)* — `[...map]`, `[...Object.values(o)]`, `Array.from(set)` that materialize insertion order into an array; suppressed when immediately `.sort()`-ed.
- **`.forEach`** *(LOW)* — over an Object view or `new Map/Set`; suppressed when sorted first.
- **`JSON.stringify` of an unordered object** *(LOW)* — a bare object identifier or a spread/merge whose key order isn't provably consensused (the serialized output/state is consensused byte-for-byte). Fixed-key object **literals**, arrays, primitives, a sorted replacer array, and `.sort()`-ed arguments are recognized as safe and **not** flagged.
- **Locale / timezone / ICU** *(MEDIUM)* — `toLocaleString` / `toLocaleDateString` / `toLocaleTimeString`, `localeCompare`, and `Intl.*`. These depend on the host's locale + ICU collation/format data (and timezone), which differ across nodes — the produced string or sort order diverges. Fix: locale-independent formatting + a **code-point** comparison (`a < b ? -1 : a > b ? 1 : 0`), never `localeCompare`.
- **Floating-point literals** *(LOW)* — a non-integer float literal (e.g. `0.1`, or a negative-exponent scientific literal `1.5e-3` / `1e-3`) or `parseFloat(` feeding contract math: float rounding / NaN / `-0` can differ across engines/hosts. Fix: integer math only (work in **drops**, `Math.floor(a*n/d)`). Integer literals, integer-valued positive-exponent literals (`1.5e3` = 1500), and integer division/floor are **not** flagged.

**Still out of scope** (documented honestly — these are NOT caught):

- **Bare float math / untyped division** — `a / b` of two unknown-typed variables (no float literal / `parseFloat` signal) is too noisy to flag soundly, so it isn't. Only float **literals** and `parseFloat` are flagged.
- **Deeper data-flow** — order divergence behind multi-hop aliases (`const n = m`), function-return values (`const m = makeMap()`), Map passed in as a parameter, object spreads merged across several statements, dynamically-built call expressions, or a Map reached through a separate-statement reassignment (`let m; m = new Map()`). The alias pass covers the *direct* `const x = new Map()` and the *direct member* `this.m = new Map()` cases, not arbitrary data-flow.
- **Known acceptable false-positives** — e.g. `[...Object.keys(o)].sort()` still fires the base `iteration-order` rule (the spread hides the `.sort()` from it); a `Date.now()` used only for a local log; an order-independent reduction over a Map; an honest array iterated as `for (const x of this.list)` (a member with no array-allowlist entry). These flag *safe* code (the acceptable direction) — justify or refactor.

So: it catches the breakers beginners hit, and biases toward over-flagging the iteration/serialize
classes — it does **not** prove determinism. Settlement *safety* is proven separately by the
trifecta (`xahc-prover`). Always test on a real multi-node cluster before mainnet.

## Settlement → the trifecta handoff

When a value-moving dApp (escrow / subscription payout / payment_splitter) pays out on Xahau, it
does so from the **cluster's multisig account**. `generate_settlement` produces a three-part bundle:

1. **Cluster-side payout code** (`xahau/settle.js`, a starting point) — the contract decides amounts *under consensus*; **signing happens OUTSIDE consensus** via the cluster's threshold/multisig signer. The generated file signs with a single key as a placeholder; replace it with multisig aggregation.
2. **The install** of the reference `agent_guardrail` Hook (from xahc-prover; exercised on Xahau testnet) on the cluster account, with your per-tx `LIM` (spend cap, 8-byte big-endian HookParameter) + optional `DST` (destination lock) — emitted as an **unsigned** `xahc install-tx` SetHook to sign offline.
3. **The exact `xahc prove` command** to prove the guardrail invariant on *your* built WASM.

The bundle **emits the prove/install commands — it does not assert a safety verdict itself.** While
the Hook is installed, an outgoing Payment over `LIM` or to a non-allowed `DST` is rejected by the
ledger even if the payout code or a signer is wrong. **Limits:** the Hook fires on `Payment` only,
so it does not stop the account's signers from removing it (`SetHook`) or moving value with other
transaction types — protect the signer quorum. A PROVEN verdict from `xahc prove` holds within the
prover's modeled scope; deploy only on PROVEN for *your* build.

## Install

Requires **Node.js 20+**. The server speaks MCP over **stdio**; your MCP client launches it.

### From npm

```bash
npx -y evernode-mcp --help      # run without installing (prints usage and exits)
npm install -g evernode-mcp     # or install the `evernode-mcp` command globally
evernode-mcp --smoke            # offline self-test (templates lint-clean, checker + math work)
```

Run with no arguments, `evernode-mcp` waits for an MCP client on stdin/stdout — it is not an interactive CLI.

### Add it to an MCP client

**Claude Code:**
```bash
claude mcp add evernode -- npx -y evernode-mcp
```

**Claude Desktop** (`claude_desktop_config.json`), or any client that takes an `mcpServers` block:
```json
{
  "mcpServers": {
    "evernode": { "command": "npx", "args": ["-y", "evernode-mcp"] }
  }
}
```
If you installed globally, `"command": "evernode-mcp"` with no `args` works too. No environment
variables, API keys, or wallet are needed.

### From GitHub / source

```bash
npm install -g github:Hugegreencandle/evernode-mcp   # builds on install via `prepare`
```

Or clone and build:
```bash
git clone https://github.com/Hugegreencandle/evernode-mcp && cd evernode-mcp
npm install        # the `prepare` script compiles dist/ automatically
npm run smoke      # offline self-test
npm test           # the full Vitest suite (offline)
```

## Network access

Ten of the twelve tools are fully offline. Only `recommend_hosts` and `host_diagnostics` make
network calls, and only when you don't supply host data yourself:

| tool | request | notes |
|---|---|---|
| `recommend_hosts` | `GET https://api.onledger.net/hosts?active=true&sort=…&limit=…[&minSlots&minRep&country&minRam]` | public, no key; 10 s timeout; 30 s in-memory cache |
| `host_diagnostics` | `GET https://api.onledger.net/hosts/<r-address>` | public, no key; 10 s timeout; 30 s in-memory cache |

OnLedger is a third-party service, not run by this project; its data is only as current as its
index. On any failure the tools return an empty result with a note — never fabricated hosts.
Nothing is ever written to a ledger. (The generated `xahau/settle.js` file connects to
`wss://xahau-test.net` when *you* run it; the server itself never does.)

## Usage

Point any MCP-capable agent at the server and just ask, e.g.:

- *"Scaffold an escrow HotPocket dApp called `vault`."* → `generate_contract`
- *"Is this contract safe for cluster consensus?"* (paste source) → `check_determinism`
- *"Does this contract use the HotPocket API correctly?"* (paste source) → `check_contract_api`
- *"Scaffold an oracle dApp that agrees on a price via NPL."* → `generate_contract` (`oracle_consumer`)
- *"Is host rHostAddr… healthy enough to lease?"* → `host_diagnostics` (live)
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

- **Tests** (`tests/`): `determinism` (rule coverage incl. the regression floor + new gaps), `contractApi` (good contract clean + each API-misuse flagged), `advisor` (lease math, host ranking, error mapping, pattern/deploy branches), `templates` (per-template build + determinism-clean + per-template invariants), `settlement` (LIM encoding + trifecta handoff shape), `outputSchemas` (each handler's real output validates against its published schema), `index` (end-to-end: every tool driven through an in-memory MCP client, input-schema rejection), `hostDiagnostics` (healthy / red-flag / not-found / fetch-failure honesty, mocked fetch), and `fetch` (live-path hardening, mocked).
- **CI** (`.github/workflows/ci.yml`): on push + PR to `main`, runs `npm ci`, `npm run build`, `npm test`, and `npm run smoke` on Node 20.
- **`createServer()`** is exported from `src/index.ts` so the server can be driven over an in-memory transport in tests without starting the stdio transport.

## Honest scope (recap)

- Generates code + guidance; **does not** acquire leases, sign, or move EVR/XAH. No key custody.
- `recommend_hosts` fetches **live** from OnLedger (or ranks a list you supply) — it never fabricates host addresses/specs; on fetch failure it returns empty hosts + a note explaining why, never a fabricated fallback.
- `check_determinism` and `check_contract_api` are **heuristic** source scans (mostly per-line regex) — guidance, not a proof; `check_determinism` is biased to over-flag the iteration/serialize classes and has documented blind spots (bare float math, multi-hop data-flow). Test on a real multi-node cluster before mainnet.
- Settlement safety (Hook spend limits) is **delegated to the Hooks toolchain** (`xahc prove`) — this server emits the prove/install commands, never a verdict. The guardrail Hook covers outgoing `Payment`s only.
- `generate_deploy_commands` and `explain_error` are static guidance. The command syntax was checked against `evdevkit` 0.7.22 and `hpdevkit` 0.6.9 (npm, 2026-10-01); check the [Evernode docs](https://docs.evernode.org) or `--help` if your version differs.
- `estimate_lease_cost` is arithmetic on the rate you supply; hosts set their own rates.

## License

**MIT © 2026 Dane Brown.** Open source; see [LICENSE](LICENSE). Not affiliated with Evernode Labs
or the Xahau project. `check_determinism` findings are heuristic guidance, not a guarantee — always
test on a multi-node cluster and review before mainnet.
