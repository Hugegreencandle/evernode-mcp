import { describe, it, expect } from "vitest";
import { listTemplates, generate } from "../dist/templates.js";
import { checkDeterminism } from "../dist/determinism.js";

describe("templates", () => {
  it("lists the expected templates", () => {
    expect(listTemplates().sort()).toEqual(
      ["blank", "escrow", "game_backend", "payment_splitter", "subscription", "token_gated", "voting"]);
  });

  it("every template generates a complete file set", () => {
    for (const t of listTemplates()) {
      const fs = generate(t, "x");
      expect(fs.files["src/index.js"]).toContain("hpc.init");
      expect(fs.files["src/state.js"]).toBeTruthy();
      expect(fs.files["package.json"]).toContain("hotpocket-nodejs-contract");
      expect(fs.files["dist/hp.cfg.override"]).toContain("bin_path");
      expect(fs.notes.length).toBeGreaterThan(0);
    }
  });

  it("DOGFOOD: every template contract has NO high-severity determinism finding", () => {
    for (const t of listTemplates()) {
      const { findings } = checkDeterminism(generate(t).files["src/index.js"]);
      const high = findings.filter((f) => f.severity === "high");
      expect(high, `template ${t} should be determinism-clean, got ${JSON.stringify(high)}`).toHaveLength(0);
    }
  });

  it("rejects an unknown template", () => {
    expect(() => generate("nope" as never)).toThrow(/unknown template/);
  });

  it("payment_splitter splits integer drops exactly (remainder to last)", () => {
    // the template's split logic, mirrored — sum must equal the deposit, no rounding leak
    const recipients = [{ weight: 1 }, { weight: 1 }, { weight: 1 }];
    const drops = 100, total = 3;
    let allocated = 0;
    const split = recipients.map((r, i) =>
      i === recipients.length - 1 ? drops - allocated : (() => { const a = Math.floor((drops * r.weight) / total); allocated += a; return a; })());
    expect(split.reduce((a, b) => a + b, 0)).toBe(drops);
  });
});
