// Each tool's actual handler output must validate against its published outputSchema, so an agent
// can trust the `structuredContent` shape. We build a Zod object from each schema's raw shape and
// parse the real return value of the corresponding src/* function.
import { describe, it, expect } from "vitest";
import { z } from "zod";
import {
  LIST_TEMPLATES_OUT, GENERATE_CONTRACT_OUT, CHECK_DETERMINISM_OUT, RECOMMEND_PATTERN_OUT,
  CHECK_HOOK_COMPAT_OUT, GENERATE_SETTLEMENT_OUT, ESTIMATE_LEASE_OUT, RECOMMEND_HOSTS_OUT,
  DEPLOY_COMMANDS_OUT, EXPLAIN_ERROR_OUT, CHECK_CONTRACT_API_OUT, HOST_DIAGNOSTICS_OUT,
} from "../dist/outputSchemas.js";
import { listTemplates, generate } from "../dist/templates.js";
import { checkDeterminism } from "../dist/determinism.js";
import { checkContractApi } from "../dist/contractApi.js";
import { recommendPattern, estimateLease, recommendHosts, deployCommands, explainError, hostDiagnostics } from "../dist/advisor.js";
import { generateSettlement } from "../dist/settlement.js";

// The SDK validates structuredContent with .passthrough() semantics (undeclared fields pass).
const S = (shape: z.ZodRawShape) => z.object(shape).passthrough();

describe("output schemas validate real tool output", () => {
  it("list_templates", () => {
    expect(S(LIST_TEMPLATES_OUT).safeParse({ templates: listTemplates() }).success).toBe(true);
  });

  it("generate_contract (every template)", () => {
    for (const t of listTemplates()) {
      const r = S(GENERATE_CONTRACT_OUT).safeParse(generate(t, "x"));
      expect(r.success, `${t}: ${r.success ? "" : JSON.stringify(r.error?.issues)}`).toBe(true);
    }
  });

  it("check_determinism (clean + with findings)", () => {
    expect(S(CHECK_DETERMINISM_OUT).safeParse(checkDeterminism("const n = ctx.lclSeqNo;")).success).toBe(true);
    const r = S(CHECK_DETERMINISM_OUT).safeParse(checkDeterminism("const t = Date.now();"));
    expect(r.success).toBe(true);
  });

  it("check_contract_api (clean + with findings)", () => {
    expect(S(CHECK_CONTRACT_API_OUT).safeParse(checkContractApi(generate("escrow").files["src/index.js"])).success).toBe(true);
    expect(S(CHECK_CONTRACT_API_OUT).safeParse(checkContractApi("const t = Date.now();")).success).toBe(true);
  });

  it("host_diagnostics (supplied host + not-found shape)", async () => {
    const a = await hostDiagnostics({ host: { address: "rX", hostReputation: 100, maxInstances: 4, activeInstances: 1 } });
    expect(S(HOST_DIAGNOSTICS_OUT).safeParse(a).success).toBe(true);
    const b = await hostDiagnostics({});   // honest found:false shape
    expect(S(HOST_DIAGNOSTICS_OUT).safeParse(b).success).toBe(true);
  });

  it("recommend_pattern", () => {
    expect(S(RECOMMEND_PATTERN_OUT).safeParse(recommendPattern("escrow that settles XAH")).success).toBe(true);
  });

  it("check_hook_compat (the inline handler shape)", () => {
    const out = { involvesHook: true, workflow: ["1.", "2."], repos: { write: "x", simulate: "y", prove: "z" } };
    expect(S(CHECK_HOOK_COMPAT_OUT).safeParse(out).success).toBe(true);
  });

  it("generate_settlement (with + without dest)", () => {
    expect(S(GENERATE_SETTLEMENT_OUT).safeParse(generateSettlement({ template: "escrow", limitDrops: 10 })).success).toBe(true);
    expect(S(GENERATE_SETTLEMENT_OUT).safeParse(generateSettlement({ template: "escrow", limitDrops: 10, dest: "rDest" })).success).toBe(true);
  });

  it("estimate_lease_cost", () => {
    expect(S(ESTIMATE_LEASE_OUT).safeParse(estimateLease({ evrPerMoment: 2, moments: 24, nodes: 3 })).success).toBe(true);
  });

  it("recommend_hosts (supplied list, offline)", async () => {
    const out = await recommendHosts({ hosts: [{ address: "rX", leaseDrops: 5, availableInstances: 2 }], prefer: "cheap" });
    expect(S(RECOMMEND_HOSTS_OUT).safeParse(out).success).toBe(true);
  });

  it("generate_deploy_commands (all modes)", () => {
    for (const mode of ["local", "single", "cluster", "cluster-manager"] as const) {
      expect(S(DEPLOY_COMMANDS_OUT).safeParse(deployCommands({ mode })).success).toBe(true);
    }
  });

  it("explain_error (matched + unmatched)", () => {
    expect(S(EXPLAIN_ERROR_OUT).safeParse(explainError("nodes disagree on state hash")).success).toBe(true);
    expect(S(EXPLAIN_ERROR_OUT).safeParse(explainError("totally unrelated")).success).toBe(true);
  });
});
