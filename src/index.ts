#!/usr/bin/env node
// evernode-mcp — Evernode AI Builder. An MCP server that scaffolds, checks, costs, and helps
// deploy HotPocket dApps on Evernode/Xahau. Read-only/advisory: it generates files and
// guidance; it never holds keys, spends EVR, or replaces the Offledger Cluster Manager.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createRequire } from "node:module";
import { listTemplates, generate } from "./templates.js";
import { checkDeterminism } from "./determinism.js";
import { checkContractApi } from "./contractApi.js";
import { recommendPattern, estimateLease, recommendHosts, deployCommands, explainError, hostDiagnostics, type HostRow } from "./advisor.js";
import { generateSettlement } from "./settlement.js";
import {
  LIST_TEMPLATES_OUT, GENERATE_CONTRACT_OUT, CHECK_DETERMINISM_OUT, RECOMMEND_PATTERN_OUT,
  CHECK_HOOK_COMPAT_OUT, GENERATE_SETTLEMENT_OUT, ESTIMATE_LEASE_OUT, RECOMMEND_HOSTS_OUT,
  DEPLOY_COMMANDS_OUT, EXPLAIN_ERROR_OUT, CHECK_CONTRACT_API_OUT, HOST_DIAGNOSTICS_OUT,
} from "./outputSchemas.js";

// Single source of truth: package.json (dist/index.js and src/index.ts both sit one level below it).
const VERSION: string = createRequire(import.meta.url)("../package.json").version;

// Every tool returns the human-readable JSON text AND validated structuredContent. The object we
// return IS the structured payload (these tools never throw their own error result — handler
// errors propagate to the SDK), so we hand the same object to both. Keep the pretty text for
// humans; the structured copy is for agents (validated against each tool's outputSchema).
const ok = (v: object) => ({
  content: [{ type: "text" as const, text: JSON.stringify(v, null, 2) }],
  structuredContent: v as Record<string, unknown>,
});

// Shared annotations: every evernode-mcp tool is read-only/advisory (no keys, no spend, no deploy).
// openWorldHint is true ONLY for the two tools that may reach the live OnLedger API
// (recommend_hosts, host_diagnostics).
const OFFLINE = { readOnlyHint: true, openWorldHint: false, idempotentHint: true } as const;
const LIVE = { readOnlyHint: true, openWorldHint: true, idempotentHint: true } as const;

// Build + register every tool on a fresh server. Exported (not auto-connected) so tests can drive
// the real registered handlers over an in-memory transport without starting the stdio server.
export function createServer(): McpServer {
const server = new McpServer({ name: "evernode-mcp", version: VERSION });

server.registerTool("list_templates", {
  title: "List dApp templates",
  description: "List the available HotPocket dApp templates (escrow, subscription, game_backend, voting, token_gated, payment_splitter, oracle_consumer, streaming_payment, multisig_treasury, blank).",
  inputSchema: {},
  outputSchema: LIST_TEMPLATES_OUT,
  annotations: { title: "List dApp templates", ...OFFLINE },
}, async () => ok({ templates: listTemplates() }));

server.registerTool("generate_contract", {
  title: "Generate a HotPocket dApp",
  description: "Generate a HotPocket dApp file set (contract + state helper + hp.cfg.override + package.json + client) for a template. Templates avoid the known non-determinism sources (no wall-clock, randomness, or network in the contract path; time = ctx.lclSeqNo) and pass check_determinism with no HIGH findings — lint-clean, not proven deterministic.",
  inputSchema: {
    template: z.enum(["blank", "escrow", "subscription", "game_backend", "voting", "token_gated", "payment_splitter", "oracle_consumer", "streaming_payment", "multisig_treasury"]),
    name: z.string().optional().describe("project/contract name (default: mycontract)"),
  },
  outputSchema: GENERATE_CONTRACT_OUT,
  annotations: { title: "Generate a HotPocket dApp", ...OFFLINE },
}, async ({ template, name }) => ok(generate(template, name)));

server.registerTool("check_determinism", {
  title: "Check contract determinism",
  description: "Heuristic linter for HotPocket contract source: flags known non-deterministic patterns that can break cluster consensus (wall-clock, randomness, network I/O, env/host reads, timers/races, filesystem outside the state file, unordered iteration/serialization, locale/ICU, floating-point literals). HIGH findings are likely consensus breakers. A clean result means none of these patterns were found — it does not prove the contract is deterministic.",
  inputSchema: { source: z.string().describe("the contract JS/TS source to scan") },
  outputSchema: CHECK_DETERMINISM_OUT,
  annotations: { title: "Check contract determinism (heuristic)", ...OFFLINE },
}, async ({ source }) => ok(checkDeterminism(source)));

server.registerTool("check_contract_api", {
  title: "Check HotPocket contract API usage",
  description: "Heuristic static check that a HotPocket Node.js contract uses the contract API correctly: an hpc.init(...) entry point, reading ctx (users / lclSeqNo), persisting ONLY through the consensused state mechanism (no arbitrary fs writes to non-state paths), handling ctx.users I/O, using ctx.lclSeqNo for time (not Date.now), and awaiting async consensus ops. Severity-rated with fix + why. Sibling to check_determinism — guidance, NOT a proof.",
  inputSchema: { source: z.string().describe("the HotPocket contract JS/TS source to check") },
  outputSchema: CHECK_CONTRACT_API_OUT,
  annotations: { title: "Check HotPocket contract API usage (heuristic)", ...OFFLINE },
}, async ({ source }) => ok(checkContractApi(source)));

server.registerTool("recommend_pattern", {
  title: "Recommend a HotPocket pattern",
  description: "Given a plain-English use-case, recommend the HotPocket pattern (node count, state model, oracle/NPL usage, Xahau settlement) with the determinism caveats that matter.",
  inputSchema: { use_case: z.string() },
  outputSchema: RECOMMEND_PATTERN_OUT,
  annotations: { title: "Recommend a HotPocket pattern", ...OFFLINE },
}, async ({ use_case }) => ok(recommendPattern(use_case)));

server.registerTool("check_hook_compat", {
  title: "Xahau Hook settlement workflow",
  description: "Returns the recommended workflow (no analysis is performed) for a dApp that settles value on Xahau through a Hook-guarded account: build/lint the Hook with xahc, simulate it with xahau-mcp, prove the spend invariant with xahc-prover, then install via an unsigned SetHook.",
  inputSchema: { involves_hook: z.boolean().describe("does the dApp's Xahau account run a Hook?"), what: z.string().optional().describe("what the hook should enforce, e.g. 'per-tx spend limit'") },
  outputSchema: CHECK_HOOK_COMPAT_OUT,
  annotations: { title: "Xahau Hook settlement workflow", ...OFFLINE },
}, async ({ involves_hook, what }) => ok({
  involvesHook: involves_hook,
  workflow: involves_hook ? [
    "1. Author + compile the Hook with `xahc` (build → clean → lint).",
    "2. Simulate it against a sample settlement tx with `xahau-mcp` (execute_hook / simulate_transaction).",
    `3. PROVE the safety invariant with \`xahc prove\` (e.g. ${what ? `'${what}' → ` : ""}--invariant limit / conservation / authz). A PROVEN verdict holds for all inputs within the prover's modeled scope (it fails closed to INCONCLUSIVE outside it); a COUNTEREXAMPLE is the attack tx.`,
    "4. Install via `xahc install-tx` (unsigned SetHook), sign offline, deploy on the cluster's Xahau multisig account.",
  ] : ["No Hook involved — settlement (if any) is a plain Xahau Payment from the cluster account. If you add value limits later, guard the account with a Hook and prove it via the trifecta."],
  repos: { write: "github.com/Hugegreencandle/xahc", simulate: "github.com/Hugegreencandle/xahau-mcp", prove: "github.com/Hugegreencandle/xahc-prover" },
}));

server.registerTool("generate_settlement", {
  title: "Generate Xahau settlement bundle",
  description: "For a value-moving dApp, generate the cluster-side Xahau payout code (a starting point; multisig aggregation is left to you) + an unsigned `xahc install-tx` command for the agent_guardrail Hook (per-tx LIM spend cap + optional DST lock) on the cluster account + the `xahc prove` command to check it. Emits commands only — no safety verdict. While that Hook is installed it makes the ledger reject outgoing Payments over LIM or to a non-allowed DST; it fires on Payment only, so it does not stop the account's signers from removing it with SetHook or moving value with other transaction types.",
  inputSchema: {
    template: z.enum(["escrow", "subscription", "payment_splitter", "streaming_payment", "multisig_treasury"]),
    limit_drops: z.number().int().nonnegative().describe("per-tx spend cap in drops (the LIM hook param)"),
    dest: z.string().optional().describe("optional r-address to LOCK payouts to (the DST hook param)"),
    cluster_account: z.string().optional().describe("the cluster's Xahau (multisig) account r-address"),
  },
  outputSchema: GENERATE_SETTLEMENT_OUT,
  annotations: { title: "Generate Xahau settlement bundle", ...OFFLINE },
}, async ({ template, limit_drops, dest, cluster_account }) =>
  ok(generateSettlement({ template, limitDrops: limit_drops, dest, clusterAccount: cluster_account })));

server.registerTool("estimate_lease_cost", {
  title: "Estimate EVR lease cost",
  description: "Estimate tenant EVR lease cost = evrPerMoment × moments × nodes. Rates are host-set (no network standard); registration fees are host-side, not included.",
  inputSchema: {
    evr_per_moment: z.number().describe("host's per-Moment lease rate in EVR (from its offer)"),
    moments: z.number().describe("number of Moments to lease"),
    nodes: z.number().describe("cluster size"),
    moment_minutes: z.number().optional().describe("Moment window in minutes (default 60)"),
  },
  outputSchema: ESTIMATE_LEASE_OUT,
  annotations: { title: "Estimate EVR lease cost", ...OFFLINE },
}, async ({ evr_per_moment, moments, nodes, moment_minutes }) =>
  ok(estimateLease({ evrPerMoment: evr_per_moment, moments, nodes, momentMinutes: moment_minutes })));

server.registerTool("recommend_hosts", {
  title: "Recommend Evernode hosts (live)",
  description: "Fetch + rank live Evernode hosts from the public OnLedger API (api.onledger.net, which indexes the Evernode registry on Xahau) by cheap | capacity | reputation; the filters (min_reputation, min_slots, country, min_ram_mb, limit) are passed to that live query. Or pass your own `hosts` list to rank it (filters are not applied to a supplied list; top 10 returned). Real data only — never invents hosts.",
  inputSchema: {
    prefer: z.enum(["cheap", "capacity", "reputation"]).optional(),
    min_reputation: z.number().optional().describe("0–255 host reputation floor"),
    min_slots: z.number().optional().describe("minimum free instances (default 1)"),
    country: z.string().optional().describe("2-letter ISO code, e.g. DE, US, JP"),
    min_ram_mb: z.number().optional(),
    limit: z.number().optional().describe("max hosts (default 10)"),
    hosts: z.array(z.object({
      address: z.string(), leaseAmount: z.number().optional(), leaseDrops: z.number().optional(),
      availableInstances: z.number().optional(), maxInstances: z.number().optional(),
      hostReputation: z.number().optional(), ramMb: z.number().optional(), countryCode: z.string().optional(),
    })).optional().describe("optional: rank this supplied list instead of fetching live"),
  },
  outputSchema: RECOMMEND_HOSTS_OUT,
  // openWorldHint: true — may reach the live OnLedger API (as does host_diagnostics).
  annotations: { title: "Recommend Evernode hosts (live)", ...LIVE },
}, async ({ prefer, min_reputation, min_slots, country, min_ram_mb, limit, hosts }) =>
  ok(await recommendHosts({
    hosts: hosts as HostRow[] | undefined, prefer, minRep: min_reputation,
    minSlots: min_slots, country, minRam: min_ram_mb, limit,
  })));

server.registerTool("host_diagnostics", {
  title: "Diagnose an Evernode host (live)",
  description: "Health view of a single Evernode host by r-address: registration status, reputation, active/total/available instance slots, lease rate (EVR per Moment and/or drops, if the source has them), RAM/disk, and red-flags (flagged in the registry, marked inactive, reputation < 50, zero reputation, full capacity). Fetches live from the public OnLedger API (api.onledger.net) — or pass a `host` object to diagnose it. REAL data only: unknown fields are OMITTED (never invented); honest found:false + note on not-found / fetch failure.",
  inputSchema: {
    address: z.string().optional().describe("the host's Xahau r-address to look up live on OnLedger"),
    host: z.object({
      address: z.string(), leaseAmount: z.number().optional(), leaseDrops: z.number().optional(),
      availableInstances: z.number().optional(), maxInstances: z.number().optional(),
      activeInstances: z.number().optional(), hostReputation: z.number().optional(),
      ramMb: z.number().optional(), diskMb: z.number().optional(), countryCode: z.string().optional(),
      version: z.string().optional(), lastHeartbeatLedger: z.number().optional(), flagged: z.number().optional(),
      active: z.number().optional().describe("1 = active, 0 = inactive (as reported by the source)"),
    }).optional().describe("optional: diagnose this supplied host object instead of fetching live"),
  },
  outputSchema: HOST_DIAGNOSTICS_OUT,
  // openWorldHint: true — like recommend_hosts, this may reach the live OnLedger endpoint.
  annotations: { title: "Diagnose an Evernode host (live)", ...LIVE },
}, async ({ address, host }) => ok(await hostDiagnostics({ address, host: host as HostRow | undefined })));

server.registerTool("generate_deploy_commands", {
  title: "Generate deploy commands",
  description: "Generate the command sequence for: local (hpdevkit dev cluster), single (evdevkit acquire one host), cluster (evdevkit N-node cluster), or cluster-manager (connect to Offledger Cluster Manager).",
  inputSchema: {
    mode: z.enum(["local", "single", "cluster", "cluster-manager"]),
    host: z.string().optional(), nodes: z.number().optional(), instance_name: z.string().optional(),
  },
  outputSchema: DEPLOY_COMMANDS_OUT,
  annotations: { title: "Generate deploy commands", ...OFFLINE },
}, async ({ mode, host, nodes, instance_name }) =>
  ok(deployCommands({ mode, host, nodes, instanceName: instance_name }) ?? { steps: [], notes: [] }));

server.registerTool("explain_error", {
  title: "Explain an Evernode/HotPocket error",
  description: "Map a HotPocket/Evernode error message to its likely cause and fix (connection, consensus stall, no hosts, insufficient EVR, lease expiry, docker, Hook rejection).",
  inputSchema: { error_text: z.string() },
  outputSchema: EXPLAIN_ERROR_OUT,
  annotations: { title: "Explain an Evernode/HotPocket error", ...OFFLINE },
}, async ({ error_text }) => ok(explainError(error_text)));

  return server;
}

// --- smoke self-test (no MCP client needed): `node dist/index.js --smoke` ------
async function smoke() {
  const checks: [string, boolean][] = [];
  const gen = generate("payment_splitter", "splitter");
  checks.push(["generate produces index.js", !!gen.files["src/index.js"]]);
  // every shipped template must pass our OWN determinism checker on its contract (dogfood,
  // ignoring the one sanctioned fs state-file finding which is 'medium' on state.js only)
  for (const t of listTemplates()) {
    const f = generate(t).files["src/index.js"];
    const { findings } = checkDeterminism(f);
    const high = findings.filter((x) => x.severity === "high");
    checks.push([`template '${t}' has no HIGH determinism finding`, high.length === 0]);
  }
  const bad = checkDeterminism("const t = Date.now(); const r = Math.random(); await fetch('http://x');");
  checks.push(["checker flags Date.now/Math.random/fetch", bad.findings.filter((f) => f.severity === "high").length >= 3]);
  // v0.3.0 coverage: the named gaps (aliased Map/Set, spread/Array.from, forEach, JSON.stringify)
  const alias = checkDeterminism("const m = new Map();\nfor (const x of m) {}");
  checks.push(["checker flags aliased Map iteration", alias.findings.some((f) => f.rule === "iteration-order-alias")]);
  const jstr = checkDeterminism("const out = JSON.stringify(state);");
  checks.push(["checker flags JSON.stringify of an unordered object", jstr.findings.some((f) => f.rule === "json-stringify-unordered")]);
  const sorted = checkDeterminism("Object.keys(o).sort().forEach(f);\nJSON.stringify([1, 2, 3]);\nconst n = ctx.lclSeqNo;");
  checks.push(["checker suppresses sorted forEach + array stringify (no false-positive)", sorted.findings.length === 0]);
  // FP fix (real-codebase feedback): a MULTI-LINE sorted-keys canonicalizer must be SUPPRESSED...
  const mlSorted = checkDeterminism("return JSON.stringify(\n  Object.keys(value).sort().map((k) => [k, value[k]])\n);");
  checks.push(["checker suppresses multi-line sorted-keys JSON.stringify canonicalizer (no false-positive)",
    mlSorted.findings.filter((f) => f.rule === "json-stringify-unordered").length === 0]);
  // ...but the audit FALSE-NEGATIVE (JSF-1) must NOT recur: a stray `(` in a string on the call line
  // + an unrelated later `.sort()` must STILL flag (the gather must not walk into following statements).
  const jsf1 = checkDeterminism('const out = JSON.stringify(state, label("("))\n;\nconst ranked = rows.sort((a, b) => a.s - b.s);');
  checks.push(["FN-guard JSF-1: stray-paren-in-string + unrelated later sort still FLAGS json-stringify",
    jsf1.findings.some((f) => f.rule === "json-stringify-unordered")]);
  // ...and the audit FALSE-NEGATIVE (JSF-2): an unrelated sort in a non-first argument must STILL flag.
  const jsf2 = checkDeterminism("JSON.stringify(unsortedObj, keys.sort());");
  checks.push(["FN-guard JSF-2: unrelated 2nd-arg sort with unsorted 1st arg still FLAGS json-stringify",
    jsf2.findings.some((f) => f.rule === "json-stringify-unordered")]);
  // 2nd-round audit guards (regex-aware neutralize + fail-toward-flag + sorted-replacer):
  // AUDIT-2: a `)` inside a string/regex on a single-line stringify must NOT balance early + suppress
  // a spread object -> must FLAG.
  const a2tpl = checkDeterminism("JSON.stringify({ k: `a)`, ...rest });");
  const a2rgx = checkDeterminism("JSON.stringify({ k: /)/, ...rest });");
  checks.push(["FN-guard AUDIT-2: )-in-string/regex + spread object still FLAGS",
    a2tpl.findings.some((f) => f.rule === "json-stringify-unordered") &&
    a2rgx.findings.some((f) => f.rule === "json-stringify-unordered")]);
  // FN-REGEX: a regex in the FIRST arg must not break the arg-split; here the 2nd arg IS a sorted-key
  // array replacer (which provably pins output order — verified), so it is correctly SUPPRESSED.
  const fnrgx = checkDeterminism("JSON.stringify(/]/.test(x) ? a : b, Object.keys(b).sort())");
  checks.push(["regex-in-arg1 + sorted-array replacer 2nd arg suppresses (deterministic, no false-positive)",
    fnrgx.findings.filter((f) => f.rule === "json-stringify-unordered").length === 0]);
  // self-flag FP: the tool's OWN recommended fix (sorted-array replacer) must NOT be flagged.
  const repl = checkDeterminism("JSON.stringify(obj, Object.keys(obj).sort())");
  checks.push(["recommended sorted-array replacer is not self-flagged (no false-positive)",
    repl.findings.filter((f) => f.rule === "json-stringify-unordered").length === 0]);
  // ...but a sort in the SPACE (3rd) arg does NOT pin order -> must still FLAG.
  const spc = checkDeterminism("JSON.stringify(unsortedObj, null, indent(arr.sort()))");
  checks.push(["FN-guard: sort in the 3rd/space arg (not a replacer) still FLAGS",
    spc.findings.some((f) => f.rule === "json-stringify-unordered")]);
  // v0.5.0 coverage: locale/timezone, floating-point, member-expression iteration (each must FIRE).
  const loc = checkDeterminism("const s = n.toLocaleString();\narr.sort((a, b) => a.localeCompare(b));");
  checks.push(["checker flags locale/timezone (toLocaleString + localeCompare)", loc.findings.filter((f) => f.rule === "locale-timezone").length >= 2]);
  const flt = checkDeterminism("let t = 0;\nt += x * 0.1;\nconst y = parseFloat(s);");
  checks.push(["checker flags floating-point (float literal + parseFloat)", flt.findings.filter((f) => f.rule === "floating-point").length >= 2]);
  const mem = checkDeterminism("for (const x of this.m) {}");
  checks.push(["checker flags for..of over a member expression (this.m)", mem.findings.some((f) => f.rule === "iteration-order-member")]);
  // v0.5.0 honesty: integer drops math + code-point sort + user.inputs iteration stay CLEAN (no float/locale/member false-positive).
  const clean = checkDeterminism("for (const inp of user.inputs) { const v = Math.floor((total * elapsed) / dur); arr.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)); }");
  checks.push(["checker stays clean on integer math + code-point sort + user.inputs (no new false-positive)", clean.findings.length === 0]);
  checks.push(["lease math", estimateLease({ evrPerMoment: 2, moments: 24, nodes: 3 }).totalEVR === 144]);
  checks.push(["error explainer maps consensus", explainError("ledger not created, nodes disagree").matched === true]);
  // v0.4.0: the 3 new templates are determinism-clean (covered by the listTemplates loop above)
  // AND pass the new contract-API checker (correct hpc.init + ctx use + state persistence).
  for (const t of ["oracle_consumer", "streaming_payment", "multisig_treasury"] as const) {
    const f = generate(t).files["src/index.js"];
    const api = checkContractApi(f).findings.filter((x) => x.severity === "high");
    checks.push([`new template '${t}' has no HIGH contract-API finding`, api.length === 0]);
  }
  // contract-API checker: a good contract is clean; each misuse is flagged.
  const goodApi = checkContractApi(generate("escrow").files["src/index.js"]);
  checks.push(["contract-API checker: good contract is clean", goodApi.findings.length === 0]);
  // FN-guard FN-1 (FP-fix audit): a real contract that lacks the HotPocket signal words
  // (local re-export import + destructured ctx) and FORGETS init must STILL flag missing-init — the
  // scope guard must not silently skip it.
  const sigless = checkContractApi('import { Contract as C } from "./bundle.js";\nasync function fn({ users }) { await users.list(); }');
  checks.push(["FN-guard FN-1: signal-less contract missing init still FLAGS missing-init",
    sigless.findings.some((f) => f.rule === "missing-init")]);
  const badApi = checkContractApi("const t = Date.now(); ctx.users.read(inp); fs.writeFileSync('/tmp/x', 'y');");
  checks.push(["contract-API checker flags missing init + fs-outside-state + missing-await-read",
    ["missing-init", "fs-outside-state", "missing-await-read"].every((r) => badApi.findings.some((f) => f.rule === r))]);
  // host_diagnostics: NO fabrication path — a supplied host with sparse fields omits unknowns,
  // and an empty/no-input call is honest (found:false, never invents a host).
  const diag = await hostDiagnostics({ host: { address: "rTest", hostReputation: 10, maxInstances: 3, activeInstances: 3 } });
  checks.push(["host_diagnostics derives red-flags from real fields (low rep + full)",
    diag.found === true && diag.redFlags.some((f) => /reputation/.test(f)) && diag.redFlags.some((f) => /capacity/.test(f))]);
  checks.push(["host_diagnostics omits unknown fields (no lease/specs invented)",
    diag.lease === undefined && diag.specs === undefined]);
  const noDiag = await hostDiagnostics({});
  checks.push(["host_diagnostics is honest with no input (found:false, no fabricated host)",
    noDiag.found === false && !!noDiag.note]);
  // v0.5.0: numeric coercion is sound + no-fabrication. A string-typed numeric supplied as a host
  // object reaches diagnoseHost AS-IS (mapHost only runs on the fetch path), so here we assert the
  // diagnoseHost contract on real numbers; the string-coercion path is covered in hostDiagnostics.test.ts.
  const coerced = await hostDiagnostics({ host: { address: "rCoerce", hostReputation: 10, maxInstances: 3, activeInstances: 3 } });
  checks.push(["host_diagnostics red-flags derive from numeric reputation/slots",
    typeof coerced.reputation === "number" && coerced.redFlags.some((f) => /reputation/.test(f))]);
  const fail = checks.filter(([, ok]) => !ok);
  for (const [n, ok] of checks) console.log(`${ok ? "ok  " : "FAIL"} ${n}`);
  console.log(`\n${checks.length - fail.length}/${checks.length} passed`);
  process.exit(fail.length ? 1 : 0);
}

const HELP = `evernode-mcp ${VERSION} — MCP server for Evernode/HotPocket dApps (stdio)

Usage:
  evernode-mcp            start the MCP server on stdin/stdout (launched by an MCP client)
  evernode-mcp --smoke    offline self-test, exits 0 on success
  evernode-mcp --version  print the version
  evernode-mcp --help     print this help

Advisory and read-only: holds no keys, never signs or submits, never acquires a lease.
Only recommend_hosts and host_diagnostics make network calls (HTTPS GET to api.onledger.net).
https://github.com/Hugegreencandle/evernode-mcp`;

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(HELP);
} else if (process.argv.includes("--version") || process.argv.includes("-v")) {
  console.log(VERSION);
} else if (process.argv.includes("--smoke")) {
  smoke();
} else {
  const transport = new StdioServerTransport();
  await createServer().connect(transport);
  console.error(`evernode-mcp ${VERSION} on stdio`);
}
