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
});
