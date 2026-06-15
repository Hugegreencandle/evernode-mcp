// Output schemas for evernode-mcp's tools. Each is published in the tool's MCP definition so an
// agent knows the shape of the `structuredContent` it receives — without guessing field names.
//
// SAFE BY DESIGN (mirrors xahau-mcp): the MCP SDK validates `structuredContent` against these
// (safeParseAsync) and throws on mismatch. To keep that from ever turning a correct result into a
// failure, every field here is OPTIONAL and a present field can never fail by type surprise
// (z.unknown() / nullable where the value could vary). The shapes are derived from the actual
// handler return values in src/* — no invented fields. Undeclared fields pass through unchanged.
//
// HONESTY NOTE preserved in the shapes: check_determinism is a HEURISTIC linter (it returns
// `summary` text that says so), never a proof; settlement safety is delegated to the trifecta
// (the settlement shape carries `prove`/`install` commands, not a safety verdict we assert here).
import { z } from "zod";

const arr = z.array(z.unknown()).optional();
const str = z.string().optional();
const num = z.number().optional();
const bool = z.boolean().optional();
const obj = z.record(z.string(), z.unknown()).optional();

// list_templates → { templates: string[] }
export const LIST_TEMPLATES_OUT = { templates: z.array(z.string()).optional() };

// generate_contract → FileSet { template, files: Record<string,string>, notes: string[] }
export const GENERATE_CONTRACT_OUT = {
  template: str,
  files: z.record(z.string(), z.string()).optional(),
  notes: arr,
};

// check_determinism → { findings: Finding[], summary: string }
// Finding = { line, column, snippet, rule, severity, why, fix }. HEURISTIC — `summary` says so.
export const CHECK_DETERMINISM_OUT = {
  findings: z.array(z.object({
    line: num, column: num, snippet: str, rule: str,
    severity: str, why: str, fix: str,
  }).passthrough()).optional(),
  summary: str,
};

// check_contract_api → { findings: ApiFinding[], summary: string }
// ApiFinding = { line, column, snippet, rule, severity, why, fix }. HEURISTIC — `summary` says so.
export const CHECK_CONTRACT_API_OUT = {
  findings: z.array(z.object({
    line: num, column: num, snippet: str, rule: str,
    severity: str, why: str, fix: str,
  }).passthrough()).optional(),
  summary: str,
};

// recommend_pattern → { pattern: string, nodes: string, notes: string[] }
export const RECOMMEND_PATTERN_OUT = { pattern: str, nodes: str, notes: arr };

// check_hook_compat → { involvesHook, workflow: string[], repos: {...} }
export const CHECK_HOOK_COMPAT_OUT = { involvesHook: bool, workflow: arr, repos: obj };

// generate_settlement → SettlementBundle { template, limitDrops, files, install, prove, notes }
// Settlement safety is DELEGATED: `prove`/`install` are the trifecta commands, not a verdict here.
export const GENERATE_SETTLEMENT_OUT = {
  template: str, limitDrops: num,
  files: z.record(z.string(), z.string()).optional(),
  install: str, prove: str, notes: arr,
};

// estimate_lease_cost → { inputs, perNodeEVR, totalEVR, approxDurationHours, notes }
export const ESTIMATE_LEASE_OUT = {
  inputs: obj, perNodeEVR: num, totalEVR: num, approxDurationHours: num, notes: arr,
};

// recommend_hosts → either { mode:"ranked-supplied", ranked, prefer, note }
//                       or { mode:"live-onledger", source, query, note, prefer, ranked }
// REAL data only — `ranked` is empty + `note` explains on failure; nothing is fabricated.
export const RECOMMEND_HOSTS_OUT = {
  mode: str, ranked: arr, prefer: str, note: str, source: str, query: str,
};

// host_diagnostics → { found, address, source, note?, registration?, reputation?, slots?, lease?, specs?, redFlags }
// REAL data only — unknown fields are OMITTED (never invented); not-found/failure → found:false + note.
export const HOST_DIAGNOSTICS_OUT = {
  found: bool, address: str, source: str, note: str,
  registration: obj, reputation: num, slots: obj, lease: obj, specs: obj,
  redFlags: z.array(z.string()).optional(),
};

// generate_deploy_commands → { steps: string[], notes: string[] }
export const DEPLOY_COMMANDS_OUT = { steps: arr, notes: arr };

// explain_error → { matched, message? } or { matched, explanations: [{cause, fix}] }
export const EXPLAIN_ERROR_OUT = { matched: bool, message: str, explanations: arr };
