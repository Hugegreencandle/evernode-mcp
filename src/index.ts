#!/usr/bin/env node
// evernode-mcp — Evernode AI Builder. An MCP server that scaffolds, checks, costs, and helps
// deploy HotPocket dApps on Evernode/Xahau. Read-only/advisory: it generates files and
// guidance; it never holds keys, spends EVR, or replaces the Offledger Cluster Manager.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { listTemplates, generate } from "./templates.js";
import { checkDeterminism } from "./determinism.js";
import { recommendPattern, estimateLease, recommendHosts, deployCommands, explainError, type HostRow } from "./advisor.js";
import { generateSettlement } from "./settlement.js";
import {
  LIST_TEMPLATES_OUT, GENERATE_CONTRACT_OUT, CHECK_DETERMINISM_OUT, RECOMMEND_PATTERN_OUT,
  CHECK_HOOK_COMPAT_OUT, GENERATE_SETTLEMENT_OUT, ESTIMATE_LEASE_OUT, RECOMMEND_HOSTS_OUT,
  DEPLOY_COMMANDS_OUT, EXPLAIN_ERROR_OUT,
} from "./outputSchemas.js";

const VERSION = "0.3.0";

// Every tool returns the human-readable JSON text AND validated structuredContent. The object we
// return IS the structured payload (these tools never throw their own error result — handler
// errors propagate to the SDK), so we hand the same object to both. Keep the pretty text for
// humans; the structured copy is for agents (validated against each tool's outputSchema).
const ok = (v: object) => ({
  content: [{ type: "text" as const, text: JSON.stringify(v, null, 2) }],
  structuredContent: v as Record<string, unknown>,
});

// Shared annotations: every evernode-mcp tool is read-only/advisory (no keys, no spend, no deploy).
// openWorldHint is true ONLY for the one tool that may reach the live OnLedger network.
const OFFLINE = { readOnlyHint: true, openWorldHint: false, idempotentHint: true } as const;
const LIVE = { readOnlyHint: true, openWorldHint: true, idempotentHint: true } as const;

// Build + register every tool on a fresh server. Exported (not auto-connected) so tests can drive
// the real registered handlers over an in-memory transport without starting the stdio server.
export function createServer(): McpServer {
const server = new McpServer({ name: "evernode-mcp", version: VERSION });

server.registerTool("list_templates", {
  title: "List dApp templates",
  description: "List the available HotPocket dApp templates (escrow, subscription, game_backend, voting, token_gated, payment_splitter, blank).",
  inputSchema: {},
  outputSchema: LIST_TEMPLATES_OUT,
  annotations: { title: "List dApp templates", ...OFFLINE },
}, async () => ok({ templates: listTemplates() }));

server.registerTool("generate_contract", {
  title: "Generate a HotPocket dApp",
  description: "Generate a deterministic-by-construction HotPocket dApp file set (contract + state helper + hp.cfg.override + package.json + client) for a template.",
  inputSchema: {
    template: z.enum(["blank", "escrow", "subscription", "game_backend", "voting", "token_gated", "payment_splitter"]),
    name: z.string().optional().describe("project/contract name (default: mycontract)"),
  },
  outputSchema: GENERATE_CONTRACT_OUT,
  annotations: { title: "Generate a HotPocket dApp", ...OFFLINE },
}, async ({ template, name }) => ok(generate(template, name)));

server.registerTool("check_determinism", {
  title: "Check contract determinism",
  description: "Heuristic scan of HotPocket contract source for non-deterministic patterns (wall-clock, randomness, network I/O, env, timers, unordered iteration) that break cluster consensus. HIGH findings are likely consensus breakers. Guidance, not a proof.",
  inputSchema: { source: z.string().describe("the contract JS/TS source to scan") },
  outputSchema: CHECK_DETERMINISM_OUT,
  annotations: { title: "Check contract determinism (heuristic)", ...OFFLINE },
}, async ({ source }) => ok(checkDeterminism(source)));

server.registerTool("recommend_pattern", {
  title: "Recommend a HotPocket pattern",
  description: "Given a plain-English use-case, recommend the HotPocket pattern (node count, state model, oracle/NPL usage, Xahau settlement) with the determinism caveats that matter.",
  inputSchema: { use_case: z.string() },
  outputSchema: RECOMMEND_PATTERN_OUT,
  annotations: { title: "Recommend a HotPocket pattern", ...OFFLINE },
}, async ({ use_case }) => ok(recommendPattern(use_case)));

server.registerTool("check_hook_compat", {
  title: "Check Xahau Hook / WASM compatibility",
  description: "When a dApp settles value on Xahau through a Hook-guarded account, hands off to the trifecta: build/lint the Hook with xahc, simulate it with xahau-mcp, and PROVE the spend invariant with xahc-prover. Returns the recommended workflow.",
  inputSchema: { involves_hook: z.boolean().describe("does the dApp's Xahau account run a Hook?"), what: z.string().optional().describe("what the hook should enforce, e.g. 'per-tx spend limit'") },
  outputSchema: CHECK_HOOK_COMPAT_OUT,
  annotations: { title: "Check Xahau Hook / WASM compatibility", ...OFFLINE },
}, async ({ involves_hook, what }) => ok({
  involvesHook: involves_hook,
  workflow: involves_hook ? [
    "1. Author + compile the Hook with `xahc` (build → clean → lint).",
    "2. Simulate it against a sample settlement tx with `xahau-mcp` (execute_hook / simulate_transaction).",
    `3. PROVE the safety invariant with \`xahc prove\` (e.g. ${what ? `'${what}' → ` : ""}--invariant limit / conservation / authz). A PROVEN verdict bounds the account's behavior for ALL inputs; a COUNTEREXAMPLE is the attack tx.`,
    "4. Install via `xahc install-tx` (unsigned SetHook), sign offline, deploy on the cluster's Xahau multisig account.",
  ] : ["No Hook involved — settlement (if any) is a plain Xahau Payment from the cluster account. If you add value limits later, guard the account with a Hook and prove it via the trifecta."],
  repos: { write: "github.com/Hugegreencandle/xahc", simulate: "github.com/Hugegreencandle/xahau-mcp", prove: "github.com/Hugegreencandle/xahc-prover" },
}));

server.registerTool("generate_settlement", {
  title: "Generate safe Xahau settlement",
  description: "For a value-moving dApp, generate the cluster-side Xahau payout code + the install of the trifecta's PROVEN agent_guardrail Hook (per-tx LIM + optional DST lock) on the cluster account + the exact `xahc prove` command. 'Safe by construction → proven safe' — the ledger enforces the spend cap even if the contract/signer is wrong.",
  inputSchema: {
    template: z.enum(["escrow", "subscription", "payment_splitter"]),
    limit_drops: z.number().int().nonnegative().describe("per-tx spend cap in drops (the LIM hook param)"),
    dest: z.string().optional().describe("optional r-address to LOCK payouts to (the DST hook param)"),
    cluster_account: z.string().optional().describe("the cluster's Xahau (multisig) account r-address"),
  },
  outputSchema: GENERATE_SETTLEMENT_OUT,
  annotations: { title: "Generate safe Xahau settlement", ...OFFLINE },
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
  description: "Fetch + rank live Evernode hosts from OnLedger (api.onledger.net, real-time from the Xahau registry) by cheap | capacity | reputation, with optional filters. Or pass your own `hosts` list to rank it. Real data only — never invents hosts.",
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
  // openWorldHint: true — this is the ONLY tool that may reach a live external endpoint (OnLedger).
  annotations: { title: "Recommend Evernode hosts (live)", ...LIVE },
}, async ({ prefer, min_reputation, min_slots, country, min_ram_mb, limit, hosts }) =>
  ok(await recommendHosts({
    hosts: hosts as HostRow[] | undefined, prefer, minRep: min_reputation,
    minSlots: min_slots, country, minRam: min_ram_mb, limit,
  })));

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
  checks.push(["lease math", estimateLease({ evrPerMoment: 2, moments: 24, nodes: 3 }).totalEVR === 144]);
  checks.push(["error explainer maps consensus", explainError("ledger not created, nodes disagree").matched === true]);
  const fail = checks.filter(([, ok]) => !ok);
  for (const [n, ok] of checks) console.log(`${ok ? "ok  " : "FAIL"} ${n}`);
  console.log(`\n${checks.length - fail.length}/${checks.length} passed`);
  process.exit(fail.length ? 1 : 0);
}

if (process.argv.includes("--smoke")) {
  smoke();
} else {
  const transport = new StdioServerTransport();
  await createServer().connect(transport);
  console.error(`evernode-mcp ${VERSION} on stdio`);
}
