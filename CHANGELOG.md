# Changelog

All notable changes to evernode-mcp are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.5.0] - 2026-06-15

Enterprise hardening pass: closes the residual gaps a prior audit had documented as "out of scope"
by actually CLOSING them — a sound numeric-coercion fix in `host_diagnostics`, and three new
`check_determinism` rules (locale/timezone, floating-point, member-expression iteration) plus a
member-expression extension to the cross-line Map/Set alias pass. evernode-mcp stays **advisory**
(no key custody, no EVR spend, no lease acquisition, no signing). `check_determinism` is still a
HEURISTIC linter (guidance, never a proof — the checker remains deliberately flag-biased: over-flag
is acceptable, a silent miss is not), `host_diagnostics` still returns **real OnLedger data only**
(now with sound coercion — garbage is omitted, never a fabricated default), and settlement safety
stays delegated to the trifecta (xahc · xahau-mcp · xahc-prover).

### Fixed
- **`host_diagnostics` numeric type-passthrough (`src/advisor.ts` `mapHost`).** OnLedger can return a
  numeric field as a STRING (e.g. `reputation: "252"`). The old `as number` cast leaked the string
  through the `number` output schema (runtime `structuredContent` validation could fail) AND bypassed
  the numeric red-flag comparisons (a string is never `< 50`). Each numeric field is now coerced with a
  sound helper — `Number(x)` accepted **only** when `Number.isFinite`; otherwise the field is **OMITTED**
  (NO FABRICATION — never a manufactured `0`/default, never a bad type). Empty/whitespace strings (which
  `Number("")` would turn into `0`), non-finite values, booleans, and objects are all rejected to a
  clean omit. Red-flags now derive only from successfully-coerced numbers. String fields (`version`,
  `countryCode`, `hostingType`) likewise omit a non-string rather than stringifying it.

### Added — `check_determinism` coverage (each with a `why` + `fix`)
- **`locale-timezone` rule (MEDIUM).** Flags `toLocaleString` / `toLocaleDateString` /
  `toLocaleTimeString`, `localeCompare`, and `Intl.*` — host locale/ICU collation+format data (and
  timezone) differ across nodes, so the produced string or sort order diverges and consensus breaks.
- **`floating-point` rule (LOW).** Flags `parseFloat(` and a bare non-integer float **literal** (e.g.
  `0.1`) feeding contract math (engine-level rounding / NaN / `-0` divergence). Sound + low-noise:
  integer literals, integer division (`Math.floor(a*n/d)`), and dotted version-like / member tokens are
  NOT flagged. (Bare `a / b` of unknown-typed vars stays out of scope — too noisy to flag soundly.)
- **`iteration-order-member` rule (LOW).** Flags `for (const x of this.m / state.m / obj.m)` — an
  order-unprovable member-expression iteration (could be a Map/Set). Known deterministic array members
  (`user.inputs`/`outputs`) and **call** expressions (`ctx.users.list()`) are suppressed.
- **Cross-line alias pass extended to MEMBER aliases.** `collectMapSetAliases` now also learns
  `this.m = new Map()` / `state.m = new Set()` / `obj.m = new Map()` and flags iteration / spread /
  `forEach` / `Array.from` / `.entries()/.keys()/.values()` over those members (evidence-based, sound —
  not name-guessing). The same-line `const x = new Map(); for..of x` case is covered too.

### Changed
- **`game_backend` template made determinism-clean under the new locale rule.** Its leaderboard
  tiebreaker switched from `a.localeCompare(b)` (locale/ICU-dependent — a real consensus risk) to a
  **code-point** comparison (`a < b ? -1 : a > b ? 1 : 0`). This is a template *correctness fix*, not a
  rule weakening — all templates stay determinism-clean (0 findings) under the new rules.
- **README "Now covered" / "Still out of scope" sections rewritten** to reflect the shrunk out-of-scope
  list (locale, floating-point literals, and member-expression iteration moved from out-of-scope to
  covered; only bare untyped float division + deeper multi-hop data-flow remain out of scope, honestly).

### Tests
- `tests/determinism.test.ts`: +16 tests — the three new rules (fire + severity + never-HIGH +
  suppression of the deterministic fixes), the member-alias extension, and the previously-"documented
  out-of-scope" cases that are now covered moved into "new coverage" (the genuinely-still-missed cases
  re-pinned). Existing regression-floor + suppression tests all still pass (no regression).
- `tests/hostDiagnostics.test.ts`: +11 tests for the coercion fix — string-numeric coerced, garbage /
  empty-string / non-finite / boolean / object → OMITTED (no fabrication), already-number passes,
  missing stays missing, non-string version/country omitted, and string `flagged` `"0"`/`"1"` truthiness.
- Smoke (`--smoke`): +5 checks (locale, floating-point, member-expression fire; integer-math/code-point/
  `user.inputs` stay clean; coercion red-flags derive from numbers). Now 30/30; all 10 templates stay
  HIGH-clean. Suite: 275 → 302 tests, all green.

## [0.4.0] - 2026-06-15

Features pass: 3 new dApp templates (the harder consensus patterns), a contract-API checker, and a
live host-diagnostics tool. evernode-mcp stays **advisory** — no key custody, no EVR spend, no lease
acquisition. The two new checkers are HEURISTIC (guidance, never a proof), and `host_diagnostics`
returns **real OnLedger data only** (unknown fields omitted, honest on not-found/failure — never
fabricated). Settlement safety stays delegated to the trifecta (xahc · xahau-mcp · xahc-prover).

### Added
- **3 new dApp templates** (`generate_contract`), each determinism-clean (0 findings) AND contract-API-clean:
  - `oracle_consumer` — the canonical HARD pattern: external data brought in via an **NPL agreement**
    (nodes PROPOSE their observation over the Node Party Line and only ACT on a strict-majority **agreed**
    primitive value), NEVER a direct fetch. Disagreement is a deterministic no-op; the agreed datum is
    stamped with `ctx.lclSeqNo`. Demonstrates the determinism-safe way to use off-chain data.
  - `streaming_payment` — per-ledger-seq vesting: `release = f(ctx.lclSeqNo)`, integer drops only (no
    float divergence). The contract RECORDS the release; the actual transfer is **deferred** to
    `generate_settlement`.
  - `multisig_treasury` — records spend proposals + M-of-N approvals (threshold counted over a sorted
    view); on reaching the threshold it **emits the settlement step** to `generate_settlement` (ties the
    trifecta in). The contract never signs or moves value.
  - `generate_settlement` now also accepts `streaming_payment` and `multisig_treasury`.
- **New tool `check_contract_api`** (offline; `readOnlyHint:true`, `openWorldHint:false`) — a HEURISTIC
  static check (sibling to `check_determinism`, same honest "guidance, not a proof" framing) that a
  HotPocket Node.js contract uses the API correctly: flags a missing `hpc.init(...)` / contract entry,
  not reading `ctx` (users/lclSeqNo), persisting outside the consensused state mechanism (arbitrary `fs`
  writes to non-state paths), unhandled `ctx.users` I/O, `Date.now` for time instead of `lclSeqNo`
  (cross-refs determinism), and missing `await` on async consensus ops. Severity-rated with `why` + `fix`;
  output schema + input Zod + annotations.
- **New tool `host_diagnostics`** (live; `readOnlyHint:true`, `openWorldHint:true`) — health view of a
  single Evernode host by r-address (registration, reputation, active/total/available slots, lease terms,
  specs, red-flags) pulled live from OnLedger (reusing the hardened timeout/cache fetch), or diagnose a
  supplied `host`. **REAL data only**: unknown fields are OMITTED (never invented); not-found / fetch
  failure → `found:false` + a note, never a fabricated host. Output schema + input Zod + annotations.
- **Tests, 216 → 265**: 3 new templates (build + determinism-clean + per-template invariants),
  `contractApi` (good contract clean + each misuse flagged with the right rule/severity, honest summary),
  `hostDiagnostics` (healthy / red-flag / not-found / empty / fetch-failure / timeout / cached / supplied /
  no-input honesty, mocked fetch), plus e2e registry (12 tools), output-schema, and settlement-enum coverage.
- **Smoke self-test, 14 → 25 checks**: the 3 new templates determinism- + contract-API-clean, the
  contract-API checker (good clean / misuse flagged), and `host_diagnostics` no-fabrication (red-flags from
  real fields, unknown fields omitted, honest `found:false` on no input).

### Changed
- **Version 0.3.0 → 0.4.0.**
- **README** updated: the 12-tool catalog (the two new tools with returns + open-world flags; the two live
  OnLedger tools now noted), the 10-template table (3 new rows), new usage examples, and the test list.

## [0.3.0] - 2026-06-15

Depth pass: determinism-checker coverage upgrade, roughly doubled test depth, and a README brought
to full-catalog depth. evernode-mcp stays **advisory** — no key custody, no EVR spend, no lease
acquisition. `check_determinism` remains a HEURISTIC linter (never a proof), and settlement safety
stays delegated to the trifecta (xahc · xahau-mcp · xahc-prover), never re-asserted here.

### Added
- **Determinism checker — new coverage** for the audit-flagged gaps, each with a `why` + concrete `fix`:
  - `iteration-order-alias` (LOW) — a cross-line pass that flags a variable bound to `new Map()`/`new Set()`
    then iterated / spread / `forEach`'d / `Array.from`'d / `.entries()/.keys()/.values()` on a later line
    (the previously-blind alias case `const m = new Map(); for (..of m)`).
  - `iteration-order-foreach` (LOW) — `.forEach` over an `Object.keys/values/entries` view or a `new Map/Set`;
    suppressed when sorted first.
  - `iteration-order-materialize` (LOW) — spread (`[...map]`, `[...Object.values(o)]`) or `Array.from(...)` over
    a Map/Set/Object-view; suppressed when immediately `.sort()`-ed.
  - `json-stringify-unordered` (LOW) — `JSON.stringify` of a bare object identifier or a spread/merge whose key
    order isn't provably consensused; fixed-key literals, arrays, primitives, a sorted replacer array, and
    `.sort()`-ed arguments are recognized as safe and not flagged.
  - **No false-negatives, no regression:** all existing rules are kept as a floor (every original finding still
    fires — asserted by a dedicated regression-floor test block), and the new rules bias toward flagging
    (false-positive acceptable, silent miss not). All 7 templates stay determinism-clean.
- **End-to-end tool-handler tests** (`tests/index.test.ts`) — every registered tool driven through a real MCP
  `Client` over an in-memory transport: registry/annotation checks, valid `structuredContent` per tool, and
  input-schema rejection of malformed args.
- **Roughly doubled the suite, 54 → 200 tests**: per-rule regression floor + new-gap + suppression tests
  (determinism); lease boundaries (0 nodes / 0 moments / huge / custom window / non-finite), host-ranking ties /
  filters / fallbacks / caps, every mapped `explain_error` category, `recommend_pattern` branches, all
  `deploy_commands` modes (advisor); per-template build + determinism-clean + invariants (templates); LIM
  encoding boundaries + trifecta handoff shape (settlement).
- **Smoke self-test** now also asserts the new gap detection (aliased Map, `JSON.stringify` of an object) and a
  no-false-positive case (14 checks, was 11).

### Changed
- **`src/index.ts` exports `createServer()`** — the server is built by a factory and only auto-connects to stdio
  when run directly, so tests can drive the real registered handlers without starting the stdio transport.
- **`check_determinism` documentation** updated to reflect the now-covered classes vs the still-out-of-scope
  ones (floating-point, locale/timezone, deeper multi-hop data-flow, and a few honestly-listed acceptable
  false-positives). Still a heuristic linter, never a proof.
- **README** brought to full depth: trifecta tie-in, complete 10-tool catalog (annotations + what each returns),
  the 7 templates, install + MCP client config, the determinism honesty section (covered vs out-of-scope),
  the settlement → trifecta handoff, the advisory/no-key disclaimer, and dev/test/CI.

## [0.2.0] - 2026-06-15

Enterprise-hardening pass (MCP maturity). evernode-mcp stays **advisory** — no key custody, no EVR
spend, no lease acquisition. `check_determinism` remains a HEURISTIC linter (never a proof), and
settlement safety is delegated to the trifecta (xahc · xahau-mcp · xahc-prover), never re-asserted here.

### Added
- **MCP tool annotations** on all 10 tools (`readOnlyHint`, `openWorldHint`, `idempotentHint`, `title`).
  Every tool is read-only; `openWorldHint: true` is set ONLY on `recommend_hosts` (the live OnLedger
  query) and `false` on the nine offline tools. Enables client auto-approve and signals MCP maturity.
- **Structured output schemas** (`src/outputSchemas.ts`) — one per tool, published in each tool's MCP
  definition. Tools now return validated `structuredContent` alongside the existing human-readable
  text, so agents get a guaranteed shape without guessing field names. Shapes are derived from each
  handler's real return value (no invented fields); all fields optional so a correct payload never
  fails validation.
- **CI workflow** (`.github/workflows/ci.yml`): on push + PR to `main`, runs `npm ci`, `npm run build`,
  `npm test`, and `npm run smoke` on Node 20.
- Tests for every tool's output schema (real output validates) and the fetch timeout/failure/cache
  path (mocked). Suite grew 37 → 54.

### Changed
- **Fetch hardening** for the live OnLedger call (`recommend_hosts` / `fetchHostsLive`): wrapped in
  `AbortSignal.timeout(10s)`, all failures caught (HTTP error, network error, timeout/abort reported
  distinctly), plus a 30s in-memory TTL cache for successful queries. Still **honest on failure** —
  returns empty hosts + a note explaining why; never fabricates host data.

## [0.1.0] - 2026-06-14

Initial release — the Evernode AI Builder MCP server.

### Added
- 10 advisory tools for building HotPocket dApps on Evernode/Xahau: `list_templates`,
  `generate_contract`, `check_determinism`, `recommend_pattern`, `check_hook_compat`,
  `generate_settlement`, `estimate_lease_cost`, `recommend_hosts`, `generate_deploy_commands`,
  `explain_error`.
- 7 determinism-clean HotPocket dApp templates (blank, escrow, subscription, game_backend, voting,
  token_gated, payment_splitter) generated as complete file sets.
- Heuristic determinism checker (the differentiator): flags wall-clock, randomness, network I/O,
  env/host reads, timers, and unordered iteration — guidance, not a proof.
- Honest EVR lease estimator, live OnLedger host ranking (real data only), deploy-command generator,
  and an Evernode/HotPocket error explainer.
- `--smoke` offline self-test and a Vitest suite (37 tests).

[0.3.0]: https://github.com/Hugegreencandle/evernode-mcp/releases/tag/v0.3.0
[0.2.0]: https://github.com/Hugegreencandle/evernode-mcp/releases/tag/v0.2.0
[0.1.0]: https://github.com/Hugegreencandle/evernode-mcp/releases/tag/v0.1.0
