# evernode-mcp — agent guide

MCP server: the "Evernode AI Builder". Scaffolds + checks + costs + helps deploy **HotPocket
dApps** on Evernode/Xahau. Layer-2 companion to the Hooks trifecta (xahc · xahau-mcp ·
xahc-prover). TypeScript, ESM, MCP SDK 1.29, node ≥ 20 — mirrors xahau-mcp's setup.

## Reference docs (don't guess Evernode/HotPocket APIs from training — they drift)
- Evernode docs: https://docs.evernode.org  (HotPocket SDK, hpdevkit/evdevkit, hosts, cluster models)
- HotPocket contract API: `hotpocket-nodejs-contract` (`hpc.init(fn)`, `ctx.lclSeqNo`, `ctx.users`)
- Host data: XRPLWin (xahau.xrplwin.com/evernode), OnLedger, `evdevkit` host list
- Hook/Xahau settlement → the trifecta repos + `~/Desktop/xahc-prover/docs/XAHAU-DEV-REFERENCE.md`

## Layout (`src/`)
- `index.ts` — MCP server; registers every tool (one `server.registerTool` each).
- `determinism.ts` — the heuristic non-determinism scanner (the differentiator).
- `templates.ts` — the 7 dApp templates + the shared scaffold (contract/state/cfg/client).
- `advisor.ts` — pattern advice, EVR estimate, host ranking, deploy commands, error explainer.

## THE PRODUCT RULE: determinism + honesty
- HotPocket consensuses contract output across all nodes. **Non-deterministic code breaks
  consensus.** Every template MUST stay determinism-clean (no HIGH findings) — the smoke test
  enforces this; if you add/edit a template, keep it clean (use `ctx.lclSeqNo` for time, never
  `Date.now`/`Math.random`/`fetch`/`process.env`).
- **Never fabricate host data, EVR rates, or fees.** `recommend_hosts` ranks REAL supplied data;
  `estimate_lease_cost` is explicit that rates are host-set. If you can't back a number, say so.
- The server is **advisory**: no key custody, no EVR spend, no lease acquisition. It *connects
  to* the Offledger Cluster Manager, never replaces its orchestration.
- Settlement-safety claims (Hook spend limits) are delegated to the trifecta, which proves them
  — don't re-assert safety here; hand off via `check_hook_compat`.

## Build / test / run
```sh
npm install && npm run build
npm run smoke            # self-test (templates determinism-clean, checker + math work) — run after every change
node dist/index.js       # stdio MCP server
```

## Conventions
- Stage commits BY NAME (never `git add -A`). Conventional-commit; end with the
  Co-Authored-By Claude line.
