# Changelog

All notable changes to evernode-mcp are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[0.2.0]: https://github.com/Hugegreencandle/evernode-mcp/releases/tag/v0.2.0
[0.1.0]: https://github.com/Hugegreencandle/evernode-mcp/releases/tag/v0.1.0
