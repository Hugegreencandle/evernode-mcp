import { describe, it, expect } from "vitest";
import { generateSettlement } from "../dist/settlement.js";

describe("generateSettlement", () => {
  it("encodes LIM as 8-byte big-endian hex and emits install + prove commands", () => {
    const b = generateSettlement({ template: "payment_splitter", limitDrops: 5_000_000, clusterAccount: "rCluster" });
    expect(b.install).toContain("4C494D=00000000004C4B40");   // "LIM" = 5,000,000 drops
    expect(b.install).toContain("agent_guardrail.wasm");
    expect(b.install).toContain("rCluster");
    expect(b.prove).toContain("--invariant guardrail");
    expect(b.files["xahau/settle.js"]).toContain("rCluster");
    expect(b.files["xahau/settle.js"]).toMatch(/multisig|threshold/i);
  });

  it("adds a DST lock param + note when dest is given", () => {
    const b = generateSettlement({ template: "escrow", limitDrops: 1, dest: "rDest" });
    expect(b.install).toContain("445354=");                   // "DST" param present
    expect(JSON.stringify(b.notes)).toContain("rDest");
  });

  it("omits DST when no dest, and says so", () => {
    const b = generateSettlement({ template: "escrow", limitDrops: 1 });
    expect(b.install).not.toContain("445354=");
    expect(JSON.stringify(b.notes)).toMatch(/aren't destination-locked|not destination-locked/i);
  });

  it("rejects a non-integer / negative limit", () => {
    expect(() => generateSettlement({ template: "escrow", limitDrops: -5 })).toThrow();
    expect(() => generateSettlement({ template: "escrow", limitDrops: 1.5 })).toThrow();
  });

  it("references the proven + testnet-validated guardrail (honesty: no fabricated proof)", () => {
    const notes = JSON.stringify(generateSettlement({ template: "payment_splitter", limitDrops: 100 }).notes);
    expect(notes).toMatch(/PROVEN/);
    expect(notes).toMatch(/testnet|TESTNET-PROOF/);
  });

  // --- LIM encoding boundaries ---
  it("encodes 0 drops as 16 hex zeros (boundary; 0 is a valid non-negative limit)", () => {
    const b = generateSettlement({ template: "escrow", limitDrops: 0 });
    expect(b.install).toContain("4C494D=0000000000000000");
    expect(b.limitDrops).toBe(0);
  });
  it("encodes 1 drop with full 16-char left-zero padding", () => {
    expect(generateSettlement({ template: "escrow", limitDrops: 1 }).install).toContain("4C494D=0000000000000001");
  });
  it("encodes a large limit (100 XAH = 100,000,000 drops) correctly", () => {
    // 100_000_000 = 0x5F5E100
    expect(generateSettlement({ template: "escrow", limitDrops: 100_000_000 }).install).toContain("4C494D=0000000005F5E100");
  });

  // --- the trifecta handoff shape: the bundle hands off, it does not assert safety ---
  it("the bundle's prove command is the xahc-prover guardrail invariant (delegated, not asserted)", () => {
    const b = generateSettlement({ template: "payment_splitter", limitDrops: 50 });
    expect(b.prove).toMatch(/^xahc prove /);
    expect(b.prove).toContain("agent_guardrail.wasm");
    expect(b.prove).toContain("--invariant guardrail");
  });
  it("the install command is an unsigned SetHook of the PROVEN artifact (sign offline)", () => {
    const b = generateSettlement({ template: "escrow", limitDrops: 5, clusterAccount: "rCl" });
    expect(b.install).toMatch(/^xahc install-tx /);
    expect(b.install).toContain("--account rCl");
    expect(b.install).toContain("--on Payment");
    expect(b.install).toMatch(/sign offline/i);
  });
  it("does NOT assert a safety verdict itself — it emits the prove/install COMMANDS only", () => {
    // honesty: the bundle never claims 'safe'/'proven verdict' as fact; it carries the command to
    // PRODUCE the verdict. (The notes reference the artifact's prior proof, but no live verdict.)
    const b = generateSettlement({ template: "payment_splitter", limitDrops: 9 });
    expect(typeof b.prove).toBe("string");
    expect(typeof b.install).toBe("string");
    expect((b as Record<string, unknown>).verdict).toBeUndefined();
    expect((b as Record<string, unknown>).proven).toBeUndefined();
  });

  // --- settlement code shape (deterministic intent in contract, signing OUTSIDE consensus) ---
  it("the cluster settle.js signs OUTSIDE consensus and emits a Xahau Payment", () => {
    const js = generateSettlement({ template: "escrow", limitDrops: 1, clusterAccount: "rCl" }).files["xahau/settle.js"];
    expect(js).toMatch(/OUTSIDE consensus/);
    expect(js).toMatch(/TransactionType: "Payment"/);
    expect(js).toMatch(/NetworkID/);
    expect(js).toMatch(/multisig|threshold/i);
  });
  it("works for every allowed settlement template", () => {
    for (const template of ["escrow", "subscription", "payment_splitter"] as const) {
      const b = generateSettlement({ template, limitDrops: 1 });
      expect(b.template).toBe(template);
      expect(b.files["xahau/settle.js"]).toBeTruthy();
      expect(b.prove).toContain("--invariant guardrail");
    }
  });
  it("rejects a non-finite limit (NaN / Infinity)", () => {
    expect(() => generateSettlement({ template: "escrow", limitDrops: NaN })).toThrow();
    expect(() => generateSettlement({ template: "escrow", limitDrops: Infinity })).toThrow();
  });
});
