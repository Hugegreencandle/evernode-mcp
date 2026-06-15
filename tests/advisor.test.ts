import { describe, it, expect, afterEach } from "vitest";
import { estimateLease, explainError, rankHosts, recommendPattern, deployCommands, recommendHosts, __setFetchForTest, __clearHostCache } from "../dist/advisor.js";

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

  // --- boundary / edge cases ---
  it("0 nodes => 0 total (boundary, not an error — 0 is non-negative)", () => {
    const r = estimateLease({ evrPerMoment: 2, moments: 24, nodes: 0 });
    expect(r.totalEVR).toBe(0);
    expect(r.perNodeEVR).toBe(48); // per-node cost still computed
  });
  it("0 moments => 0 total and 0 duration", () => {
    const r = estimateLease({ evrPerMoment: 5, moments: 0, nodes: 3 });
    expect(r.totalEVR).toBe(0);
    expect(r.approxDurationHours).toBe(0);
  });
  it("huge moments scale linearly without overflow surprises", () => {
    const r = estimateLease({ evrPerMoment: 1, moments: 1_000_000, nodes: 3 });
    expect(r.totalEVR).toBe(3_000_000);
    expect(r.approxDurationHours).toBe(1_000_000); // 60-min moments => hours == moments
  });
  it("honors a custom moment window (momentMinutes) in the duration", () => {
    const r = estimateLease({ evrPerMoment: 1, moments: 4, nodes: 1, momentMinutes: 30 });
    expect(r.approxDurationHours).toBe(2); // 4 × 30min = 120min = 2h
    expect(r.inputs.momentMinutes).toBe(30);
  });
  it("stays HONEST: notes say rates are host-set and registration is host-side", () => {
    const notes = JSON.stringify(estimateLease({ evrPerMoment: 2, moments: 1, nodes: 1 }).notes);
    expect(notes).toMatch(/host-set/);
    expect(notes).toMatch(/Registration fees/);
    expect(notes).toMatch(/HOSTS, not tenants/);
  });
  it("rejects non-finite (NaN / Infinity) inputs", () => {
    expect(() => estimateLease({ evrPerMoment: NaN, moments: 1, nodes: 1 })).toThrow();
    expect(() => estimateLease({ evrPerMoment: Infinity, moments: 1, nodes: 1 })).toThrow();
  });
  it("rejects a negative moments and a negative nodes too", () => {
    expect(() => estimateLease({ evrPerMoment: 1, moments: -1, nodes: 1 })).toThrow();
    expect(() => estimateLease({ evrPerMoment: 1, moments: 1, nodes: -1 })).toThrow();
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

  // --- every mapped error category resolves with a cause + fix ---
  const mapped: Array<[string, string, RegExp]> = [
    ["connection", "connect failed wss://localhost", /port|cluster up|wss/i],
    ["consensus", "state mismatch — hash mismatch across nodes", /check_determinism|non-determ/i],
    ["no-hosts", "acquire failed: no offer from any host", /recommend_hosts|active host|capacity/i],
    ["insufficient-evr", "tecUNFUNDED: not enough EVR to pay the lease", /estimate_lease_cost|Fund|EVR/i],
    ["lease-expiry", "the lease expired and the instance was reclaimed", /extend|renew|re-leas/i],
    ["docker", "docker image pull failed for sashimono", /Docker|container|image/i],
    ["hook", "tecHOOK_REJECTED: GUARD_VIOLATION in the hook", /xahc-prover|xahau-mcp|invariant|guarded/i],
  ];
  for (const [name, text, fixPattern] of mapped) {
    it(`maps the '${name}' error to a cause + actionable fix`, () => {
      const r = explainError(text);
      expect(r.matched).toBe(true);
      expect(Array.isArray(r.explanations)).toBe(true);
      expect(r.explanations!.length).toBeGreaterThan(0);
      for (const e of r.explanations!) {
        expect(e.cause.length).toBeGreaterThan(0);
        expect(e.fix.length).toBeGreaterThan(0);
      }
      expect(JSON.stringify(r.explanations)).toMatch(fixPattern);
    });
  }

  it("can return MULTIPLE explanations when a message matches several patterns", () => {
    // mentions both a consensus stall AND a hook rejection
    const r = explainError("ledger stall; also tecHOOK rejected with a guard violation");
    expect(r.matched).toBe(true);
    expect(r.explanations!.length).toBeGreaterThanOrEqual(2);
  });

  it("unknown message returns a helpful message (suspect non-determinism) and no explanations", () => {
    const r = explainError("the quick brown fox");
    expect(r.matched).toBe(false);
    expect(r.message).toMatch(/non-determinism|check_determinism/i);
    expect((r as { explanations?: unknown }).explanations).toBeUndefined();
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

  // --- ranking ties, filters, fallbacks ---
  it("cheap: a tie on leaseDrops keeps both (stable, both present)", () => {
    const tied = [
      { address: "rT1", leaseDrops: 10, availableInstances: 1 },
      { address: "rT2", leaseDrops: 10, availableInstances: 1 },
    ];
    const { ranked } = rankHosts(tied, "cheap");
    expect(ranked.map((h) => h.address).sort()).toEqual(["rT1", "rT2"]);
  });
  it("cheap: falls back to leaseAmount×1e6 when leaseDrops is absent", () => {
    const mixed = [
      { address: "rDrops", leaseDrops: 20, availableInstances: 1 },
      { address: "rAmount", leaseAmount: 0.000005, availableInstances: 1 }, // 5 drops
    ];
    const { ranked } = rankHosts(mixed, "cheap");
    expect(ranked[0].address).toBe("rAmount"); // 5 drops < 20 drops
  });
  it("capacity: derives free slots from maxInstances - activeInstances when availableInstances missing", () => {
    const hs = [
      { address: "rDerived", maxInstances: 10, activeInstances: 2 }, // 8 free
      { address: "rExplicit", availableInstances: 3 },
    ];
    expect(rankHosts(hs, "capacity").ranked[0].address).toBe("rDerived");
  });
  it("drops every host when none has free capacity (cheap/capacity), with a note", () => {
    const full = [
      { address: "rF1", leaseDrops: 1, availableInstances: 0 },
      { address: "rF2", leaseDrops: 2, maxInstances: 5, activeInstances: 5 },
    ];
    const r = rankHosts(full, "cheap");
    expect(r.ranked).toHaveLength(0);
    expect(r.note).toMatch(/Ranked 0 host/);
  });
  it("caps the ranked list at 10", () => {
    const many = Array.from({ length: 25 }, (_, i) => ({ address: "r" + i, leaseDrops: i + 1, availableInstances: 1 }));
    expect(rankHosts(many, "cheap").ranked.length).toBe(10);
  });
  it("reputation: keeps zero-slot hosts (you may want a good host even if currently full)", () => {
    const hs = [
      { address: "rRep", availableInstances: 0, hostReputation: 250 },
      { address: "rLow", availableInstances: 5, hostReputation: 10 },
    ];
    const { ranked } = rankHosts(hs, "reputation");
    expect(ranked[0].address).toBe("rRep");
  });
  it("note includes the prefer dimension used", () => {
    expect(rankHosts(hosts, "capacity").note).toMatch(/capacity/);
  });
});

describe("recommendHosts orchestrator", () => {
  it("ranks a supplied list offline (no network)", async () => {
    const r = await recommendHosts({ hosts: [{ address: "rX", leaseDrops: 5, availableInstances: 2 }], prefer: "cheap" });
    expect(r.mode).toBe("ranked-supplied");
    expect(r.ranked?.[0].address).toBe("rX");
  });
  it("an EMPTY supplied list (length 0) falls through to the live path, not ranked-supplied", async () => {
    // an empty array is falsy-length, so the orchestrator should NOT treat it as supplied data.
    // We inject a mock fetch so this stays OFFLINE (no real OnLedger call in CI).
    __clearHostCache();
    __setFetchForTest(async () => ({ ok: true, status: 200, json: async () => ({ hosts: [{ address: "rLive" }] }) }) as unknown as Response);
    const r = await recommendHosts({ hosts: [], prefer: "cheap" });
    expect(r.mode).toBe("live-onledger");
    expect(r.ranked?.[0]?.address).toBe("rLive");
  });
});

afterEach(() => { __setFetchForTest(null); __clearHostCache(); });

describe("recommendPattern branches", () => {
  it("flags Xahau settlement + trifecta for a payment use-case", () => {
    const r = recommendPattern("split incoming XAH payments to recipients");
    expect(JSON.stringify(r.notes)).toMatch(/xahc-prover|multisig|settlement/i);
  });
  it("warns about external data for an oracle use-case", () => {
    expect(JSON.stringify(recommendPattern("token-gated access using a balance").notes)).toMatch(/oracle|never fetch|consensus/i);
  });
  it("suggests the local dev cluster for a test/prototype use-case", () => {
    const r = recommendPattern("just a quick local demo to learn");
    expect(r.nodes).toMatch(/hpdevkit|local/i);
  });
  it("adds the NPL note for coordination/randomness use-cases", () => {
    const r = recommendPattern("a lottery that needs a shared random seed across nodes");
    expect(JSON.stringify(r.notes)).toMatch(/NPL|seed|Math\.random/i);
  });
  it("notes the single-node trade-off for a stateless/simple task", () => {
    const r = recommendPattern("a simple stateless one node helper");
    expect(r.nodes).toMatch(/single node/i);
  });
  it("ALWAYS includes the consensus-clock determinism caveat", () => {
    for (const uc of ["anything at all", "an escrow", "a game"]) {
      expect(JSON.stringify(recommendPattern(uc).notes)).toMatch(/lclSeqNo|ledger sequence|wall clock/i);
    }
  });
  it("defaults to a 3+ node stateful consensus contract for a generic use-case", () => {
    const r = recommendPattern("some app");
    expect(r.nodes).toMatch(/3\+|multi-node|Byzantine/i);
    expect(r.pattern).toMatch(/consensus|state/i);
  });
});

describe("deployCommands (all modes)", () => {
  it("local deploy uses hpdevkit", () => {
    expect(JSON.stringify(deployCommands({ mode: "local" }))).toMatch(/hpdevkit/);
  });
  it("single deploy uses evdevkit acquire + the chosen host", () => {
    const r = deployCommands({ mode: "single", host: "rHOST123", instanceName: "myapp" });
    const s = JSON.stringify(r);
    expect(s).toMatch(/evdevkit acquire/);
    expect(s).toMatch(/rHOST123/);
  });
  it("single deploy uses a placeholder when no host given", () => {
    expect(JSON.stringify(deployCommands({ mode: "single" }))).toMatch(/<HOST_XAHAU_ADDRESS>/);
  });
  it("cluster deploy reflects the requested node count", () => {
    expect(JSON.stringify(deployCommands({ mode: "cluster", nodes: 5 }))).toMatch(/cluster create 5/);
  });
  it("cluster deploy defaults to 3 nodes", () => {
    expect(JSON.stringify(deployCommands({ mode: "cluster" }))).toMatch(/cluster create 3/);
  });
  it("cluster-manager connects, never replaces, the Offledger Cluster Manager", () => {
    const s = JSON.stringify(deployCommands({ mode: "cluster-manager" }));
    expect(s).toMatch(/Cluster Manager/);
    expect(s).toMatch(/complement|does not take over|advises/i);
  });
  it("every mode returns non-empty steps + notes", () => {
    for (const mode of ["local", "single", "cluster", "cluster-manager"] as const) {
      const r = deployCommands({ mode })!;
      expect(r.steps.length).toBeGreaterThan(0);
      expect(r.notes.length).toBeGreaterThan(0);
    }
  });
});
