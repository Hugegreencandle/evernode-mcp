// check_contract_api tests: a good HotPocket contract is clean; each known misuse is flagged with
// the right rule + severity. Heuristic guidance, not a proof — the summary says so.
import { describe, it, expect } from "vitest";
import { checkContractApi } from "../dist/contractApi.js";
import { listTemplates, generate } from "../dist/templates.js";

const rules = (src: string) => new Set(checkContractApi(src).findings.map((f) => f.rule));
const sev = (src: string, rule: string) => checkContractApi(src).findings.find((f) => f.rule === rule)?.severity;

describe("check_contract_api — good contracts are clean", () => {
  it("every shipped template contract has NO contract-API finding", () => {
    for (const t of listTemplates()) {
      const { findings } = checkContractApi(generate(t).files["src/index.js"]);
      expect(findings, `template ${t} should be API-clean, got ${JSON.stringify(findings.map((f) => f.rule))}`).toHaveLength(0);
    }
  });

  it("a hand-written minimal correct contract is clean", () => {
    const src = `import HotPocket from "hotpocket-nodejs-contract";
const contractFn = async (ctx) => {
  for (const user of ctx.users.list()) {
    for (const inp of user.inputs) {
      const msg = (await ctx.users.read(inp)).toString();
      await user.send(JSON.stringify({ echo: msg, ledger: ctx.lclSeqNo }));
    }
  }
};
const hpc = new HotPocket.Contract();
hpc.init(contractFn);`;
    expect(checkContractApi(src).findings).toHaveLength(0);
  });

  it("the clean summary states it is heuristic guidance, not a proof", () => {
    const s = checkContractApi("const hpc = new HotPocket.Contract(); hpc.init(async (ctx) => { ctx.lclSeqNo; });").summary;
    expect(s).toMatch(/not a proof/i);
  });
});

describe("check_contract_api — each misuse is flagged", () => {
  it("missing hpc.init / contract entry point (HIGH)", () => {
    const src = `const contractFn = async (ctx) => { ctx.users.list(); };`;
    expect(rules(src).has("missing-init")).toBe(true);
    expect(sev(src, "missing-init")).toBe("high");
  });

  it("init present but no new HotPocket.Contract() (MEDIUM)", () => {
    const src = `hpc.init(async (ctx) => { ctx.lclSeqNo; });`;
    expect(rules(src).has("init-without-contract")).toBe(true);
    expect(sev(src, "init-without-contract")).toBe("medium");
  });

  it("ignores ctx entirely (HIGH)", () => {
    const src = `const hpc = new HotPocket.Contract(); hpc.init(async () => { return 1; });`;
    expect(rules(src).has("ignores-ctx")).toBe(true);
    expect(sev(src, "ignores-ctx")).toBe("high");
  });

  it("arbitrary fs write to a non-state path (HIGH fs-outside-state)", () => {
    const src = `const hpc = new HotPocket.Contract(); hpc.init(async (ctx) => {
      ctx.lclSeqNo; fs.writeFileSync("/tmp/log.txt", "x"); });`;
    expect(rules(src).has("fs-outside-state")).toBe(true);
    expect(sev(src, "fs-outside-state")).toBe("high");
  });

  it("does NOT flag the sanctioned state.json persistence", () => {
    const src = `fs.writeFileSync("state.json", JSON.stringify(s));
                 const data = fs.readFileSync("state.json", "utf8");`;
    expect(rules(src).has("fs-outside-state")).toBe(false);
  });

  it("missing await on ctx.users.read (HIGH)", () => {
    const src = `const hpc = new HotPocket.Contract(); hpc.init(async (ctx) => {
      for (const u of ctx.users.list()) { const m = ctx.users.read(u.inputs[0]); await u.send("ok"); } });`;
    expect(rules(src).has("missing-await-read")).toBe(true);
    expect(sev(src, "missing-await-read")).toBe("high");
  });

  it("does NOT flag an awaited ctx.users.read", () => {
    const src = `const m = await ctx.users.read(inp);`;
    expect(rules(src).has("missing-await-read")).toBe(false);
  });

  it("missing await on user.send (MEDIUM)", () => {
    const src = `const hpc = new HotPocket.Contract(); hpc.init(async (ctx) => {
      for (const user of ctx.users.list()) { const m = await ctx.users.read(user.inputs[0]); user.send("ok"); } });`;
    expect(rules(src).has("missing-await-send")).toBe(true);
    expect(sev(src, "missing-await-send")).toBe("medium");
  });

  it("Date.now for time instead of lclSeqNo (HIGH time-not-lclseqno)", () => {
    const src = `const hpc = new HotPocket.Contract(); hpc.init(async (ctx) => {
      const t = Date.now(); await Promise.resolve(t); ctx.users.list(); });`;
    expect(rules(src).has("time-not-lclseqno")).toBe(true);
    expect(sev(src, "time-not-lclseqno")).toBe("high");
  });

  it("users listed but inputs never read (MEDIUM inputs-not-read)", () => {
    const src = `const hpc = new HotPocket.Contract(); hpc.init(async (ctx) => {
      for (const u of ctx.users.list()) { await u.send("hi"); } });`;
    expect(rules(src).has("inputs-not-read")).toBe(true);
  });

  it("flags multiple issues at once with a summary that counts them", () => {
    const src = `const t = Date.now(); ctx.users.read(inp); fs.writeFileSync("/etc/passwd", "x");`;
    const r = checkContractApi(src);
    expect(r.findings.length).toBeGreaterThanOrEqual(3);
    expect(r.summary).toMatch(/high/);
    expect(r.summary).toMatch(/not a proof/i);
  });
});
