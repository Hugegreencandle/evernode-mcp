import { describe, it, expect } from "vitest";
import { checkDeterminism, type Severity } from "../dist/determinism.js";

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

  // ---------------------------------------------------------------------------
  // REGRESSION FLOOR: every pre-existing rule MUST still fire after the v0.3.0
  // coverage upgrade. A coverage upgrade that silently dropped an old finding
  // would be the worst failure (a false-negative), so we re-assert each here.
  // ---------------------------------------------------------------------------
  describe("regression floor — every original rule still fires", () => {
    const cases: Array<[string, string, Severity]> = [
      ["wall-clock-time", "const t = Date.now();", "high"],
      ["wall-clock-time", "const t = performance.now();", "high"],
      ["wall-clock-time", "const t = new Date();", "high"],
      ["randomness", "const r = Math.random();", "high"],
      ["randomness", "const r = crypto.randomUUID();", "high"],
      ["randomness", "const r = crypto.getRandomValues(buf);", "high"],
      ["network-io", "await fetch('http://x');", "high"],
      ["network-io", "const a = axios('http://x');", "high"],
      ["node-env", "const x = process.env.FOO;", "high"],
      ["node-env", "const x = process.pid;", "high"],
      ["node-env", "const h = os.hostname();", "high"],
      ["timers", "setTimeout(fn, 100);", "medium"],
      ["timers", "setInterval(fn, 100);", "medium"],
      ["race", "await Promise.race([a, b]);", "medium"],
      ["race", "await Promise.any([a, b]);", "medium"],
      ["unordered-iteration", "for (const k in obj) {}", "low"],
      ["iteration-order", "const xs = Object.keys(obj);", "low"],
      ["filesystem", "fs.readFileSync('x');", "medium"],
      ["filesystem", "fs.writeFileSync('x', y);", "medium"],
    ];
    for (const [rule, src, sev] of cases) {
      it(`${rule} fires (${sev}) on: ${src}`, () => {
        const { findings } = checkDeterminism(src);
        expect(findings.some((f) => f.rule === rule && f.severity === sev),
          `expected ${rule}@${sev}, got ${JSON.stringify(findings.map((f) => f.rule + "@" + f.severity))}`).toBe(true);
      });
    }
  });

  // ---------------------------------------------------------------------------
  // NEW COVERAGE (v0.3.0): the audit-flagged gaps. Each must be CAUGHT — a miss
  // is a false-negative. Sorted/literal forms must be SUPPRESSED (false-positive
  // is acceptable, a silent miss is not).
  // ---------------------------------------------------------------------------
  describe("new coverage — aliased Map/Set (cross-line)", () => {
    it("flags for..of over a Map reached through a variable alias", () => {
      const { findings } = checkDeterminism("const m = new Map();\nfor (const [k, v] of m) { out.push(v); }");
      expect(findings.some((f) => f.rule === "iteration-order-alias")).toBe(true);
    });
    it("flags for..of over a Set alias", () => {
      const { findings } = checkDeterminism("let s = new Set();\nfor (const x of s) {}");
      expect(findings.some((f) => f.rule === "iteration-order-alias")).toBe(true);
    });
    it("flags spread of a Map alias", () => {
      const { findings } = checkDeterminism("const m = new Map();\nconst arr = [...m];");
      expect(findings.some((f) => f.rule === "iteration-order-alias")).toBe(true);
    });
    it("flags .forEach over a Map alias", () => {
      const { findings } = checkDeterminism("const m = new Map();\nm.forEach((v) => acc.push(v));");
      expect(findings.some((f) => f.rule === "iteration-order-alias")).toBe(true);
    });
    it("flags Array.from over a Set alias", () => {
      const { findings } = checkDeterminism("const s = new Set();\nconst a = Array.from(s);");
      expect(findings.some((f) => f.rule === "iteration-order-alias")).toBe(true);
    });
    it("flags .entries()/.keys()/.values() on a Map alias", () => {
      for (const it of ["entries", "keys", "values"]) {
        const { findings } = checkDeterminism(`const m = new Map();\nconst e = m.${it}();`);
        expect(findings.some((f) => f.rule === "iteration-order-alias"),
          `${it}()`).toBe(true);
      }
    });
    it("aliased findings are LOW (never HIGH — must not break the templates' HIGH-only smoke)", () => {
      const { findings } = checkDeterminism("const m = new Map();\nfor (const x of m) {}");
      expect(findings.filter((f) => f.rule === "iteration-order-alias" && f.severity !== "low").length).toBe(0);
    });
    it("does NOT add an alias finding when a per-line iteration rule already fired on that spot", () => {
      // `for (..of new Map())` is caught by the per-line iteration-order rule; the alias pass must
      // not double-report. (Single line, no alias var, so this only tests no spurious alias add.)
      const { findings } = checkDeterminism("for (const x of new Map(pairs)) {}");
      expect(findings.filter((f) => f.line === 1 && f.rule.startsWith("iteration-order")).length).toBe(1);
    });
    it("does NOT flag a name that was never bound to a Map/Set", () => {
      const { findings } = checkDeterminism("const arr = [1, 2, 3];\nfor (const x of arr) {}\narr.forEach((y) => z(y));");
      expect(findings.some((f) => f.rule === "iteration-order-alias")).toBe(false);
    });
  });

  describe("new coverage — .forEach over Object view / inline Map", () => {
    it("flags Object.keys(...).forEach as low", () => {
      const { findings } = checkDeterminism("Object.keys(obj).forEach((k) => result.push(k));");
      expect(findings.find((f) => f.rule === "iteration-order-foreach")?.severity).toBe("low");
    });
    it("flags new Map(...).forEach", () => {
      const { findings } = checkDeterminism("new Map(pairs).forEach((v) => acc.push(v));");
      expect(findings.some((f) => f.rule === "iteration-order-foreach")).toBe(true);
    });
    it("does NOT flag a sorted forEach: Object.keys(o).sort().forEach(...)", () => {
      const { findings } = checkDeterminism("Object.keys(obj).sort().forEach((k) => result.push(k));");
      expect(findings.some((f) => f.rule === "iteration-order-foreach")).toBe(false);
    });
  });

  describe("new coverage — spread / Array.from materialization", () => {
    it("flags spread of Object.values into an array", () => {
      const { findings } = checkDeterminism("const a = [...Object.values(obj)];");
      expect(findings.some((f) => f.rule === "iteration-order-materialize")).toBe(true);
    });
    it("flags Array.from over a new Map", () => {
      const { findings } = checkDeterminism("const a = Array.from(new Map(pairs));");
      expect(findings.some((f) => f.rule === "iteration-order-materialize")).toBe(true);
    });
    it("does NOT flag a spread that is immediately sorted", () => {
      const { findings } = checkDeterminism("const a = [...Object.keys(obj)].sort();");
      expect(findings.some((f) => f.rule === "iteration-order-materialize")).toBe(false);
    });
    it("does NOT flag Array.from(...).sort()", () => {
      const { findings } = checkDeterminism("const a = Array.from(set).sort((x, y) => x - y);");
      expect(findings.some((f) => f.rule === "iteration-order-materialize")).toBe(false);
    });
  });

  describe("new coverage — JSON.stringify of unordered objects", () => {
    it("flags JSON.stringify of a bare object identifier", () => {
      const { findings } = checkDeterminism("const out = JSON.stringify(state);");
      expect(findings.find((f) => f.rule === "json-stringify-unordered")?.severity).toBe("low");
    });
    it("flags JSON.stringify of a merged/spread object", () => {
      const { findings } = checkDeterminism("const out = JSON.stringify({ ...a, ...b });");
      expect(findings.some((f) => f.rule === "json-stringify-unordered")).toBe(true);
    });
    it("does NOT flag a fixed-key object literal", () => {
      const { findings } = checkDeterminism("user.send(JSON.stringify({ ok: true, n: count }));");
      expect(findings.some((f) => f.rule === "json-stringify-unordered")).toBe(false);
    });
    it("does NOT flag stringify of an array or a primitive", () => {
      expect(checkDeterminism("JSON.stringify([1, 2, 3]);").findings.some((f) => f.rule === "json-stringify-unordered")).toBe(false);
      expect(checkDeterminism('JSON.stringify("hello");').findings.some((f) => f.rule === "json-stringify-unordered")).toBe(false);
    });
    it("does NOT flag stringify with a sorted replacer array", () => {
      const { findings } = checkDeterminism("JSON.stringify(obj, Object.keys(obj).sort());");
      expect(findings.some((f) => f.rule === "json-stringify-unordered")).toBe(false);
    });
    it("does NOT flag stringify whose argument is itself sorted (fromEntries(entries.sort()))", () => {
      const { findings } = checkDeterminism("JSON.stringify(Object.fromEntries(entries.sort()));");
      expect(findings.some((f) => f.rule === "json-stringify-unordered")).toBe(false);
    });
    it("json-stringify finding is never HIGH (keeps templates' HIGH-only smoke clean)", () => {
      const { findings } = checkDeterminism("JSON.stringify(state);");
      expect(findings.filter((f) => f.rule === "json-stringify-unordered" && f.severity === "high").length).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // DOCUMENTED KNOWN-MISSES (adversarial sweep 2026-06-15). These are NOT bugs:
  // each is explicitly listed in README "Still out of scope" (deeper data-flow,
  // locale/timezone, floating-point). They are pinned here so a future change
  // can't silently start CLAIMING coverage it doesn't have — if you make any of
  // these fire, move it out of the README out-of-scope list in the same commit.
  // A heuristic is allowed to miss; an UNDOCUMENTED miss in a covered class is not.
  // ---------------------------------------------------------------------------
  describe("documented out-of-scope — deeper data-flow (known-miss, see README)", () => {
    it("misses a Map reached through bare reassignment (let m; m = new Map())", () => {
      // decl pass only learns `const|let|var X = new Map(...)`; a separate-statement
      // reassignment is multi-hop data-flow, documented as out of scope.
      const { findings } = checkDeterminism("let m;\nm = new Map();\nfor (const x of m) {}");
      expect(findings.some((f) => f.rule === "iteration-order-alias")).toBe(false);
    });
    it("misses a chained alias of an alias (const n = m; for..of n)", () => {
      const { findings } = checkDeterminism("const m = new Map();\nconst n = m;\nfor (const x of n) {}");
      expect(findings.some((f) => f.rule.startsWith("iteration-order"))).toBe(false);
    });
    it("misses a Map iterated via property access (this.m / state.m)", () => {
      expect(checkDeterminism("for (const x of this.m) {}").findings.length).toBe(0);
      expect(checkDeterminism("for (const x of state.m) {}").findings.length).toBe(0);
    });
    it("misses a Map passed in as a function parameter", () => {
      const { findings } = checkDeterminism("function f(m) { for (const x of m) {} }");
      expect(findings.length).toBe(0);
    });
    it("misses a Map returned from a call (const m = makeMap(); for..of m)", () => {
      const { findings } = checkDeterminism("const m = makeMap();\nfor (const x of m) {}");
      expect(findings.some((f) => f.rule.startsWith("iteration-order"))).toBe(false);
    });
    it("misses Object.entries reached through a helper/alias (for..of e)", () => {
      const { findings } = checkDeterminism("const e = ent(obj);\nfor (const x of e) {}");
      expect(findings.length).toBe(0);
    });
    it("misses Object.getOwnPropertyNames enumeration", () => {
      const { findings } = checkDeterminism("for (const k of Object.getOwnPropertyNames(obj)) {}");
      expect(findings.length).toBe(0);
    });
    it("misses Date/random reached through destructuring or alias (const {now}=Date / const r=Math.random)", () => {
      expect(checkDeterminism("const { now } = Date;\nconst t = now();").findings.length).toBe(0);
      expect(checkDeterminism("const r = Math.random;\nconst v = r();").findings.length).toBe(0);
      expect(checkDeterminism("const n = Date.now;\nconst t = n();").findings.length).toBe(0);
    });
    it("misses a multi-line `for (\\n ... of new Map())` (per-line regex limitation)", () => {
      const { findings } = checkDeterminism("for (\n  const x of new Map()\n) {}");
      expect(findings.some((f) => f.rule.startsWith("iteration-order"))).toBe(false);
    });
    it("misses an aliased Map spread into a CALL `f(...m)` (only array spread [...m] is tracked)", () => {
      const { findings } = checkDeterminism("const m = new Map();\nf(...m);");
      expect(findings.some((f) => f.rule === "iteration-order-alias")).toBe(false);
    });
  });

  describe("documented out-of-scope — locale & floating-point (known-miss, see README)", () => {
    it("misses toLocaleString / Intl.NumberFormat (locale-dependent formatting)", () => {
      expect(checkDeterminism("const s = n.toLocaleString();").findings.length).toBe(0);
      expect(checkDeterminism("const s = new Intl.NumberFormat().format(n);").findings.length).toBe(0);
    });
    it("misses locale-sensitive sort (a.localeCompare(b))", () => {
      const { findings } = checkDeterminism("arr.sort((a, b) => a.localeCompare(b));");
      expect(findings.length).toBe(0);
    });
    it("misses floating-point accumulation", () => {
      const { findings } = checkDeterminism("let t = 0; for (const x of xs) t += x * 0.1;");
      expect(findings.length).toBe(0);
    });
  });

  describe("in-class coverage stays sound for the covered shapes (no silent in-class miss)", () => {
    it("reduce/map/filter over an Object view STILL flag (the view itself is order-sensitive)", () => {
      expect(checkDeterminism("const s = Object.values(obj).reduce((a, b) => a + b, 0);")
        .findings.some((f) => f.rule === "iteration-order")).toBe(true);
      expect(checkDeterminism("const r = Object.entries(obj).map(([k, v]) => k + v);")
        .findings.some((f) => f.rule === "iteration-order")).toBe(true);
      expect(checkDeterminism("const r = Object.keys(obj).filter((k) => k > 1);")
        .findings.some((f) => f.rule === "iteration-order")).toBe(true);
    });
    it("JSON.stringify of a Map-derived / aliased object STILL flags", () => {
      expect(checkDeterminism("const o = Object.fromEntries(m);\nconst s = JSON.stringify(o);")
        .findings.some((f) => f.rule === "json-stringify-unordered")).toBe(true);
      expect(checkDeterminism("const m = new Map();\nconst s = JSON.stringify(m);")
        .findings.some((f) => f.rule === "json-stringify-unordered")).toBe(true);
    });
    it("JSON.stringify whose arg sits on the next line still flags (fails toward scanning)", () => {
      const { findings } = checkDeterminism("JSON.stringify(\n  state\n);");
      expect(findings.some((f) => f.rule === "json-stringify-unordered")).toBe(true);
    });
  });

  describe("comment/string edges for the new rules", () => {
    it("does not flag JSON.stringify mentioned only in a comment", () => {
      const { findings } = checkDeterminism("const x = 1; // call JSON.stringify(state) somewhere");
      expect(findings.length).toBe(0);
    });
    it("does not flag an alias use commented out", () => {
      const { findings } = checkDeterminism("const m = new Map();\n// m.forEach((v) => x(v));\nconst y = 1;");
      expect(findings.some((f) => f.rule === "iteration-order-alias")).toBe(false);
    });
    it("does not treat // inside a string as a comment (no swallow) for new rules", () => {
      const { findings } = checkDeterminism('log("http://x"); const out = JSON.stringify(state);');
      expect(findings.some((f) => f.rule === "json-stringify-unordered")).toBe(true);
    });
  });

  describe("finding shape is well-formed", () => {
    it("every finding has line/column ≥ 1, a snippet, rule, severity, why and fix", () => {
      const { findings } = checkDeterminism(
        "const t = Date.now();\nconst m = new Map();\nfor (const x of m) {}\nconst out = JSON.stringify(state);");
      expect(findings.length).toBeGreaterThan(0);
      for (const f of findings) {
        expect(f.line).toBeGreaterThanOrEqual(1);
        expect(f.column).toBeGreaterThanOrEqual(1);
        expect(typeof f.snippet).toBe("string");
        expect(f.rule.length).toBeGreaterThan(0);
        expect(["high", "medium", "low"]).toContain(f.severity);
        expect(f.why.length).toBeGreaterThan(0);
        expect(f.fix.length).toBeGreaterThan(0);
      }
    });
    it("summary reports counts and the heuristic caveat when issues exist", () => {
      const { summary } = checkDeterminism("const t = Date.now();");
      expect(summary).toMatch(/high/);
      expect(summary).toMatch(/consensus/i);
    });
  });
});
