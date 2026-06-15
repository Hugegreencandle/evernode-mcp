import { describe, it, expect } from "vitest";
import { estimateLease, explainError, rankHosts, recommendPattern, deployCommands, recommendHosts } from "../dist/advisor.js";

describe("estimateLease", () => {
  it("computes total = evrPerMoment × moments × nodes", () => {
    const r = estimateLease({ evrPerMoment: 2, moments: 24, nodes: 3 });
    expect(r.totalEVR).toBe(144);
    expect(r.perNodeEVR).toBe(48);
    expect(r.approxDurationHours).toBe(24);
  });
  it("rejects negative inputs", () => {
    expect(() => estimateLease({ evrPerMoment: -1, moments: 1, nodes: 1 })).toThrow();
  });
});

describe("explainError", () => {
  it("maps a consensus stall to non-determinism", () => {
    const r = explainError("ledger not created, nodes disagree on state hash");
    expect(r.matched).toBe(true);
    expect(JSON.stringify(r)).toMatch(/determinism|non-determ/i);
  });
  it("maps connection failures", () => {
    expect(explainError("WebSocket ECONNREFUSED wss://localhost:8081").matched).toBe(true);
  });
  it("returns matched:false for an unknown message", () => {
    expect(explainError("totally unrelated text").matched).toBe(false);
  });
});

describe("rankHosts (supplied data)", () => {
  const hosts = [
    { address: "rA", leaseDrops: 100, availableInstances: 1, hostReputation: 200 },
    { address: "rB", leaseDrops: 10, availableInstances: 3, hostReputation: 255 },
    { address: "rC", leaseDrops: 50, availableInstances: 0, hostReputation: 240 }, // no free slots
    { address: "rFlag", leaseDrops: 1, availableInstances: 5, hostReputation: 255, flagged: 1 },
  ];
  it("cheap orders by leaseDrops asc and drops flagged + zero-slot hosts", () => {
    const { ranked } = rankHosts(hosts, "cheap");
    expect(ranked.map((h) => h.address)).toEqual(["rB", "rA"]); // rC(0 slots) and rFlag(flagged) excluded
  });
  it("capacity orders by available slots", () => {
    expect(rankHosts(hosts, "capacity").ranked[0].address).toBe("rB");
  });
  it("reputation orders by reputation and keeps zero-slot hosts", () => {
    const { ranked } = rankHosts(hosts, "reputation");
    expect(ranked[0].address).toBe("rB");
    expect(ranked.some((h) => h.address === "rC")).toBe(true);
  });
  it("empty list returns a clear note, never invented hosts", () => {
    const r = rankHosts([], "cheap");
    expect(r.ranked).toHaveLength(0);
    expect(r.note).toMatch(/never invents/);
  });
});

describe("recommendHosts orchestrator", () => {
  it("ranks a supplied list offline (no network)", async () => {
    const r = await recommendHosts({ hosts: [{ address: "rX", leaseDrops: 5, availableInstances: 2 }], prefer: "cheap" });
    expect(r.mode).toBe("ranked-supplied");
    expect(r.ranked?.[0].address).toBe("rX");
  });
});

describe("recommendPattern + deployCommands", () => {
  it("flags Xahau settlement + trifecta for a payment use-case", () => {
    const r = recommendPattern("split incoming XAH payments to recipients");
    expect(JSON.stringify(r.notes)).toMatch(/xahc-prover|multisig|settlement/i);
  });
  it("warns about external data for an oracle use-case", () => {
    expect(JSON.stringify(recommendPattern("token-gated access using a balance").notes)).toMatch(/oracle|never fetch|consensus/i);
  });
  it("local deploy uses hpdevkit; cluster-manager connects not replaces", () => {
    expect(JSON.stringify(deployCommands({ mode: "local" }))).toMatch(/hpdevkit/);
    expect(JSON.stringify(deployCommands({ mode: "cluster-manager" }))).toMatch(/Cluster Manager/);
  });
});
