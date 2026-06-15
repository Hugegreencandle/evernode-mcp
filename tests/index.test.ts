// End-to-end tool-handler tests: spin up the REAL MCP server (createServer) over an in-memory
// transport and call each registered tool through a Client, exactly as an agent would. This
// exercises the registered handlers, their input Zod schemas, and the validated structuredContent
// (the SDK validates it against each tool's outputSchema — a shape mismatch would throw here).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../dist/index.js";

let client: Client;

beforeAll(async () => {
  const server = createServer();
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
});
afterAll(async () => { await client.close(); });

// helper: call a tool, return its parsed structuredContent (and assert it isn't an error result).
async function call(name: string, args: Record<string, unknown> = {}) {
  const r = await client.callTool({ name, arguments: args });
  expect(r.isError, `${name} returned isError: ${JSON.stringify(r.content)}`).toBeFalsy();
  return r.structuredContent as Record<string, any>;
}

describe("MCP server tool registry", () => {
  it("registers exactly the 12 advisory tools", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "check_contract_api", "check_determinism", "check_hook_compat", "estimate_lease_cost",
      "explain_error", "generate_contract", "generate_deploy_commands", "generate_settlement",
      "host_diagnostics", "list_templates", "recommend_hosts", "recommend_pattern",
    ]);
  });

  it("every tool is read-only; only the live OnLedger tools open the world", async () => {
    const { tools } = await client.listTools();
    const live = new Set(["recommend_hosts", "host_diagnostics"]);
    for (const t of tools) {
      expect(t.annotations?.readOnlyHint, `${t.name} should be readOnly`).toBe(true);
      expect(t.annotations?.openWorldHint, `${t.name} openWorldHint`).toBe(live.has(t.name));
    }
  });

  it("every tool publishes an outputSchema", async () => {
    const { tools } = await client.listTools();
    for (const t of tools) expect(t.outputSchema, `${t.name} outputSchema`).toBeTruthy();
  });
});

describe("tool handlers return valid structuredContent", () => {
  it("list_templates", async () => {
    const s = await call("list_templates");
    expect(s.templates).toContain("escrow");
    expect(s.templates).toContain("oracle_consumer");
    expect(s.templates.length).toBe(10);
  });

  it("generate_contract (each template)", async () => {
    for (const template of ["blank", "escrow", "subscription", "game_backend", "voting", "token_gated",
                            "payment_splitter", "oracle_consumer", "streaming_payment", "multisig_treasury"]) {
      const s = await call("generate_contract", { template, name: "x" });
      expect(s.template).toBe(template);
      expect(s.files["src/index.js"]).toContain("hpc.init");
    }
  });

  it("check_contract_api flags HIGH misuse and is clean on a good contract", async () => {
    const bad = await call("check_contract_api", { source: "const t = Date.now(); ctx.users.read(inp);" });
    expect(bad.findings.some((f: any) => f.severity === "high")).toBe(true);
    expect(bad.summary).toMatch(/not a proof/i);
    const good = await call("check_contract_api", { source: "const hpc = new HotPocket.Contract(); hpc.init(async (ctx) => { for (const u of ctx.users.list()) { const m = await ctx.users.read(u.inputs[0]); await u.send('ok'+ctx.lclSeqNo); } });" });
    expect(good.findings.length).toBe(0);
  });

  it("check_determinism flags HIGH consensus breakers", async () => {
    const s = await call("check_determinism", { source: "const t = Date.now(); const r = Math.random();" });
    expect(s.findings.some((f: any) => f.severity === "high")).toBe(true);
    expect(s.summary).toMatch(/high/);
  });

  it("check_determinism on clean code returns no findings + the heuristic note", async () => {
    const s = await call("check_determinism", { source: "const n = ctx.lclSeqNo;" });
    expect(s.findings.length).toBe(0);
    expect(s.summary).toMatch(/No non-deterministic patterns/);
  });

  it("recommend_pattern", async () => {
    const s = await call("recommend_pattern", { use_case: "escrow that pays out XAH" });
    expect(typeof s.pattern).toBe("string");
    expect(JSON.stringify(s.notes)).toMatch(/lclSeqNo|settlement/i);
  });

  it("check_hook_compat (hook + no-hook branches)", async () => {
    const yes = await call("check_hook_compat", { involves_hook: true, what: "per-tx spend limit" });
    expect(yes.involvesHook).toBe(true);
    expect(JSON.stringify(yes.workflow)).toMatch(/xahc prove/);
    expect(yes.repos.prove).toMatch(/xahc-prover/);
    const no = await call("check_hook_compat", { involves_hook: false });
    expect(no.involvesHook).toBe(false);
    expect(JSON.stringify(no.workflow)).toMatch(/No Hook involved/);
  });

  it("generate_settlement (with + without dest)", async () => {
    const a = await call("generate_settlement", { template: "escrow", limit_drops: 5_000_000, cluster_account: "rCl" });
    expect(a.install).toContain("4C494D=00000000004C4B40");
    expect(a.prove).toContain("--invariant guardrail");
    const b = await call("generate_settlement", { template: "payment_splitter", limit_drops: 1, dest: "rDest" });
    expect(b.install).toContain("445354=");
  });

  it("estimate_lease_cost", async () => {
    const s = await call("estimate_lease_cost", { evr_per_moment: 2, moments: 24, nodes: 3 });
    expect(s.totalEVR).toBe(144);
    expect(s.perNodeEVR).toBe(48);
  });

  it("recommend_hosts ranks a SUPPLIED list (offline, no network)", async () => {
    const s = await call("recommend_hosts", {
      prefer: "cheap",
      hosts: [
        { address: "rA", leaseDrops: 100, availableInstances: 1 },
        { address: "rB", leaseDrops: 10, availableInstances: 1 },
      ],
    });
    expect(s.mode).toBe("ranked-supplied");
    expect(s.ranked[0].address).toBe("rB");
  });

  it("host_diagnostics diagnoses a SUPPLIED host (offline, no network) + honest on no input", async () => {
    const s = await call("host_diagnostics", { host: { address: "rH", hostReputation: 10, maxInstances: 2, activeInstances: 2 } });
    expect(s.found).toBe(true);
    expect(s.address).toBe("rH");
    expect(Array.isArray(s.redFlags)).toBe(true);
    expect(s.redFlags.some((f: string) => /reputation|capacity/.test(f))).toBe(true);
    expect(s.lease).toBeUndefined();   // no fabrication of unknown fields
    const none = await call("host_diagnostics", {});
    expect(none.found).toBe(false);
    expect(none.note).toMatch(/provide a host/i);
  });

  it("generate_settlement accepts the new value-moving templates", async () => {
    for (const template of ["streaming_payment", "multisig_treasury"]) {
      const s = await call("generate_settlement", { template, limit_drops: 1_000_000, cluster_account: "rCl" });
      expect(s.template).toBe(template);
      expect(s.install).toContain("agent_guardrail.wasm");
      expect(s.prove).toContain("--invariant guardrail");
    }
  });

  it("generate_deploy_commands (each mode)", async () => {
    for (const mode of ["local", "single", "cluster", "cluster-manager"]) {
      const s = await call("generate_deploy_commands", { mode });
      expect(Array.isArray(s.steps)).toBe(true);
      expect(s.steps.length).toBeGreaterThan(0);
    }
  });

  it("explain_error (matched + unmatched)", async () => {
    const m = await call("explain_error", { error_text: "nodes disagree, state hash mismatch" });
    expect(m.matched).toBe(true);
    const u = await call("explain_error", { error_text: "totally unrelated" });
    expect(u.matched).toBe(false);
  });
});

describe("input schema validation (bad input is rejected by the Zod schema)", () => {
  // The MCP SDK validates each tool's inputSchema and returns an ERROR RESULT (isError: true) with
  // the Zod message — it does not throw. We assert that error result fires for malformed input.
  async function expectInputError(name: string, args: Record<string, unknown>) {
    const r = await client.callTool({ name, arguments: args });
    expect(r.isError, `${name} should reject ${JSON.stringify(args)}`).toBe(true);
    return r;
  }

  it("generate_contract rejects an unknown template enum value", async () => {
    const r = await expectInputError("generate_contract", { template: "not-a-template" });
    expect(JSON.stringify(r.content)).toMatch(/Invalid|expected one of/i);
  });

  it("generate_settlement rejects a negative limit_drops (nonnegative int schema)", async () => {
    await expectInputError("generate_settlement", { template: "escrow", limit_drops: -1 });
  });

  it("generate_settlement rejects a non-integer limit_drops", async () => {
    await expectInputError("generate_settlement", { template: "escrow", limit_drops: 1.5 });
  });

  it("check_determinism rejects a missing required 'source'", async () => {
    await expectInputError("check_determinism", {});
  });

  it("generate_deploy_commands rejects an unknown mode", async () => {
    await expectInputError("generate_deploy_commands", { mode: "warp" });
  });

  it("estimate_lease_cost rejects a non-number evr_per_moment", async () => {
    await expectInputError("estimate_lease_cost", { evr_per_moment: "lots", moments: 1, nodes: 1 });
  });

  it("a VALID call right after a rejected one still works (server not wedged)", async () => {
    await expectInputError("estimate_lease_cost", { evr_per_moment: "x", moments: 1, nodes: 1 });
    const s = await call("estimate_lease_cost", { evr_per_moment: 1, moments: 1, nodes: 1 });
    expect(s.totalEVR).toBe(1);
  });
});
