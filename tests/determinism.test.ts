import { describe, it, expect } from "vitest";
import { checkDeterminism } from "../dist/determinism.js";

describe("determinism checker", () => {
  it("flags wall-clock, randomness and network as HIGH", () => {
    const { findings } = checkDeterminism(
      "const t = Date.now();\nconst r = Math.random();\nawait fetch('http://x');\nconst d = new Date();");
    const high = findings.filter((f) => f.severity === "high");
    const rules = new Set(high.map((f) => f.rule));
    expect(rules.has("wall-clock-time")).toBe(true);
    expect(rules.has("randomness")).toBe(true);
    expect(rules.has("network-io")).toBe(true);
    expect(high.length).toBeGreaterThanOrEqual(3);
  });

  it("flags process.env / os stats as HIGH (per-node environment)", () => {
    const { findings } = checkDeterminism("const x = process.env.FOO; const h = os.hostname();");
    expect(findings.some((f) => f.rule === "node-env" && f.severity === "high")).toBe(true);
  });

  it("flags for..in as low and timers as medium", () => {
    const { findings } = checkDeterminism("for (const k in obj) {}\nsetTimeout(fn, 100);");
    expect(findings.find((f) => f.rule === "unordered-iteration")?.severity).toBe("low");
    expect(findings.find((f) => f.rule === "timers")?.severity).toBe("medium");
  });

  it("flags process.hrtime() AND process.hrtime.bigint() as HIGH wall-clock", () => {
    const a = checkDeterminism("const x = process.hrtime();");
    expect(a.findings.some((f) => f.rule === "wall-clock-time" && f.severity === "high")).toBe(true);
    const b = checkDeterminism("const y = process.hrtime.bigint();");
    expect(b.findings.some((f) => f.rule === "wall-clock-time" && f.severity === "high")).toBe(true);
  });

  it("flags crypto.randomInt and crypto.randomFill(Sync) as HIGH randomness", () => {
    for (const src of ["const n = crypto.randomInt(10);",
                       "crypto.randomFill(buf, cb);",
                       "crypto.randomFillSync(buf);"]) {
      const { findings } = checkDeterminism(src);
      expect(findings.some((f) => f.rule === "randomness" && f.severity === "high")).toBe(true);
    }
  });

  it("flags os.platform/arch/tmpdir/endianness as HIGH node-env", () => {
    for (const call of ["os.platform()", "os.arch()", "os.tmpdir()", "os.endianness()"]) {
      const { findings } = checkDeterminism(`const x = ${call};`);
      expect(findings.some((f) => f.rule === "node-env" && f.severity === "high")).toBe(true);
    }
  });

  it("flags Object.keys/values/entries iteration as low (iteration-order)", () => {
    for (const call of ["Object.keys(obj)", "Object.values(obj)", "Object.entries(obj)"]) {
      const { findings } = checkDeterminism(`const xs = ${call};\nfor (const x of xs) {}`);
      const f = findings.find((x) => x.rule === "iteration-order");
      expect(f?.severity).toBe("low");
    }
  });

  it("flags for..of over an inline Map/Set as low (iteration-order)", () => {
    // The scanner is regex-only: it can match Map/Set named ON the for..of line. A Map/Set
    // reached only through a prior-line alias (`const m = new Map(); for (..of m)`) is an
    // honest out-of-scope case (documented in README), not a detected one.
    const a = checkDeterminism("for (const [k, v] of new Map(pairs)) {}");
    expect(a.findings.some((f) => f.rule === "iteration-order" && f.severity === "low")).toBe(true);
    const b = checkDeterminism("for (const x of new Set(items)) {}");
    expect(b.findings.some((f) => f.rule === "iteration-order" && f.severity === "low")).toBe(true);
  });

  it("does NOT flag Object.keys/entries when provably sorted (.sort() chained)", () => {
    const a = checkDeterminism("for (const k of Object.keys(obj).sort()) {}");
    expect(a.findings.some((f) => f.rule === "iteration-order")).toBe(false);
    const b = checkDeterminism("const board = Object.entries(scores).sort((x, y) => y[1] - x[1]);");
    expect(b.findings.some((f) => f.rule === "iteration-order")).toBe(false);
  });

  it("iteration-order is never HIGH (must not break templates' HIGH-only smoke)", () => {
    const { findings } = checkDeterminism("const xs = Object.values(obj);");
    expect(findings.filter((f) => f.rule === "iteration-order" && f.severity === "high").length).toBe(0);
  });

  it("passes clean deterministic code with zero findings", () => {
    const { findings, summary } = checkDeterminism(
      "const sorted = Object.keys(state).sort();\nfor (const k of sorted) { total += state[k]; }\nconst now = ctx.lclSeqNo;");
    expect(findings.length).toBe(0);
    expect(summary).toMatch(/No non-deterministic patterns/);
  });

  it("ignores patterns inside line comments", () => {
    const { findings } = checkDeterminism("// do not use Date.now() here\nconst x = 1;");
    expect(findings.length).toBe(0);
  });

  it("does NOT swallow code after a URL literal (the // in http:// is not a comment)", () => {
    // regression: stripLineComment used indexOf('//') and truncated at the URL's //,
    // silently dropping the Date.now() after it (a false negative).
    const { findings } = checkDeterminism('log("see http://example.com"); const t = Date.now();');
    expect(findings.some((f) => f.rule === "wall-clock-time" && f.severity === "high")).toBe(true);
  });

  it("still strips a real trailing // comment after code", () => {
    const { findings } = checkDeterminism('const x = 1; // Date.now() mentioned only in a comment');
    expect(findings.length).toBe(0);
  });
});
