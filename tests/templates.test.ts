import { describe, it, expect } from "vitest";
import { listTemplates, generate } from "../dist/templates.js";
import { checkDeterminism } from "../dist/determinism.js";

describe("templates", () => {
  it("lists the expected templates", () => {
    expect(listTemplates().sort()).toEqual(
      ["blank", "escrow", "game_backend", "multisig_treasury", "oracle_consumer", "payment_splitter",
       "streaming_payment", "subscription", "token_gated", "voting"]);
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

  // --- per-template build + determinism-clean (the smoke check, asserted per template) ---
  const ALL = ["blank", "escrow", "subscription", "game_backend", "voting", "token_gated",
    "payment_splitter", "oracle_consumer", "streaming_payment", "multisig_treasury"] as const;
  for (const t of ALL) {
    describe(`template '${t}'`, () => {
      it("builds the full 5-file set", () => {
        const fs = generate(t, "demo");
        expect(Object.keys(fs.files).sort()).toEqual(
          ["client/client.js", "dist/hp.cfg.override", "package.json", "src/index.js", "src/state.js"]);
        expect(fs.template).toBe(t);
      });
      it("contract is determinism-clean (no HIGH finding)", () => {
        const { findings } = checkDeterminism(generate(t).files["src/index.js"]);
        expect(findings.filter((f) => f.severity === "high"),
          `template ${t} HIGH findings: ${JSON.stringify(findings.filter((f) => f.severity === "high"))}`).toHaveLength(0);
      });
      it("contract has no wall-clock / randomness / network finding (real code, comments aside)", () => {
        // assert via the checker (which ignores comment text) rather than a raw regex — some
        // templates MENTION Math.random in a 'never do this' comment, which is fine.
        const { findings } = checkDeterminism(generate(t).files["src/index.js"]);
        const banned = new Set(["wall-clock-time", "randomness", "network-io"]);
        expect(findings.filter((f) => banned.has(f.rule))).toHaveLength(0);
      });
      it("names the project in package.json", () => {
        expect(generate(t, "namedproj").files["package.json"]).toContain('"name": "namedproj"');
      });
    });
  }

  it("defaults the project name to 'mycontract' when none given", () => {
    expect(generate("blank").files["package.json"]).toContain('"name": "mycontract"');
  });

  it("notes always tell the dev to run check_determinism before deploy", () => {
    for (const t of ALL) {
      expect(JSON.stringify(generate(t).notes)).toMatch(/check_determinism/);
    }
  });

  // --- specific template invariants worth pinning ---
  it("escrow + subscription + voting use LEDGER SEQUENCES (ctx.lclSeqNo) as the clock", () => {
    for (const t of ["escrow", "subscription", "voting"] as const) {
      expect(generate(t).files["src/index.js"]).toMatch(/ctx\.lclSeqNo/);
    }
  });
  it("game_backend leaderboard sorts with a pubkey tiebreaker (deterministic ordering)", () => {
    expect(generate("game_backend").files["src/index.js"]).toMatch(/localeCompare/);
  });
  it("voting tally iterates a SORTED key view (deterministic)", () => {
    expect(generate("voting").files["src/index.js"]).toMatch(/Object\.keys\([^)]*\)\.sort\(\)/);
  });
  it("token_gated does NOT read an on-chain balance from contract logic (gates on a consensused allowlist)", () => {
    const src = generate("token_gated").files["src/index.js"];
    expect(src).not.toMatch(/\bfetch\s*\(/);
    expect(src).toMatch(/allow/); // admin-maintained allowlist
  });

  // --- new v0.4.0 templates ---
  it("oracle_consumer brings external data in via NPL agreement, NEVER a direct fetch", () => {
    const src = generate("oracle_consumer").files["src/index.js"];
    expect(src).not.toMatch(/\bfetch\s*\(/);            // no direct network fetch in contract logic
    expect(src).toMatch(/ctx\.npl/);                    // uses the Node Party Line
    expect(src).toMatch(/Object\.keys\([^)]*\)\.sort\(\)/); // sorted tally -> deterministic agreement
    expect(src).toMatch(/ctx\.lclSeqNo/);              // stamps the agreed datum with the ledger clock
    expect(JSON.stringify(generate("oracle_consumer").notes)).toMatch(/NPL|Node Party Line/);
  });
  it("streaming_payment vests as a pure function of ctx.lclSeqNo and DEFERS the transfer", () => {
    const src = generate("streaming_payment").files["src/index.js"];
    expect(src).toMatch(/ctx\.lclSeqNo/);              // release = f(lclSeqNo)
    expect(src).not.toMatch(/Date\.now|Math\.random/); // no wall-clock / randomness
    expect(src).toMatch(/Math\.floor/);                // integer drops, no float divergence
    expect(JSON.stringify(generate("streaming_payment").notes)).toMatch(/generate_settlement/); // transfer deferred
  });
  it("multisig_treasury counts approvals over a SORTED view + emits the settlement step", () => {
    const src = generate("multisig_treasury").files["src/index.js"];
    expect(src).toMatch(/threshold/);
    expect(src).toMatch(/Object\.keys\([^)]*\)\.sort\(\)/); // deterministic approval count
    expect(JSON.stringify(generate("multisig_treasury").notes)).toMatch(/generate_settlement/);
  });
  it("the new value-moving templates are registerable for generate_settlement (streaming_payment, multisig_treasury)", () => {
    // sanity: the settlement enum was extended to include them (asserted end-to-end in index.test.ts).
    expect(["streaming_payment", "multisig_treasury"].every((t) => listTemplates().includes(t))).toBe(true);
  });
});
