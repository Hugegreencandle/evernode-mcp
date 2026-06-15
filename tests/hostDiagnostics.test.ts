// host_diagnostics tests. We inject a fake fetch (no real network) to exercise: a healthy host,
// a red-flag host, not-found (404), and fetch-failure HONESTY (found:false + note, never invented
// host data). Also asserts the no-fabrication guarantee: unknown source fields are OMITTED.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { hostDiagnostics, diagnoseHost, fetchHostByAddress, __setFetchForTest, __clearHostCache } from "../dist/advisor.js";

beforeEach(() => __clearHostCache());
afterEach(() => __setFetchForTest(null));

function jsonResp(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body } as unknown as Response;
}

describe("diagnoseHost (pure, no network)", () => {
  it("a healthy host has no real red-flags and reports the present fields", () => {
    const d = diagnoseHost({
      address: "rGood", hostReputation: 200, maxInstances: 10, activeInstances: 2,
      leaseAmount: 0.5, ramMb: 4096, diskMb: 51200, countryCode: "DE", version: "0.10.0",
    });
    expect(d.found).toBe(true);
    expect(d.reputation).toBe(200);
    expect(d.slots).toEqual({ active: 2, total: 10, available: 8 });
    expect(d.lease?.evrPerMoment).toBe(0.5);
    expect(d.specs).toEqual({ ramMb: 4096, diskMb: 51200 });
    expect(d.registration?.countryCode).toBe("DE");
    // no genuine red-flags -> the "none detected" advisory entry
    expect(d.redFlags.some((f) => /none detected/.test(f))).toBe(true);
  });

  it("a red-flag host surfaces low reputation + full capacity + flagged", () => {
    const d = diagnoseHost({ address: "rBad", hostReputation: 10, maxInstances: 3, activeInstances: 3, flagged: 1 });
    expect(d.redFlags.some((f) => /reputation/.test(f))).toBe(true);
    expect(d.redFlags.some((f) => /capacity/.test(f))).toBe(true);
    expect(d.redFlags.some((f) => /FLAGGED/.test(f))).toBe(true);
  });

  it("NO FABRICATION: a sparse host omits unknown lease/specs/version fields (never invents them)", () => {
    const d = diagnoseHost({ address: "rSparse" });
    expect(d.found).toBe(true);
    expect(d.lease).toBeUndefined();
    expect(d.specs).toBeUndefined();
    expect(d.slots).toBeUndefined();
    expect(d.reputation).toBeUndefined();
    expect(d.registration?.version).toBeUndefined();
  });
});

describe("hostDiagnostics (live path, mocked fetch)", () => {
  it("healthy host fetched live by address", async () => {
    __setFetchForTest(async () => jsonResp({ address: "rLive", hostReputation: 180, maxInstances: 5, activeInstances: 1, leaseAmount: 0.2 }));
    const d = await hostDiagnostics({ address: "rLive" });
    expect(d.found).toBe(true);
    expect(d.address).toBe("rLive");
    expect(d.reputation).toBe(180);
    expect(d.slots?.available).toBe(4);
  });

  it("tolerates a { host: {...} } wrapped response", async () => {
    __setFetchForTest(async () => jsonResp({ host: { address: "rWrap", hostReputation: 90 } }));
    const d = await hostDiagnostics({ address: "rWrap" });
    expect(d.found).toBe(true);
    expect(d.address).toBe("rWrap");
  });

  it("red-flag host fetched live (low rep + full capacity)", async () => {
    __setFetchForTest(async () => jsonResp({ address: "rWarn", hostReputation: 5, maxInstances: 2, activeInstances: 2 }));
    const d = await hostDiagnostics({ address: "rWarn" });
    expect(d.found).toBe(true);
    expect(d.redFlags.some((f) => /reputation/.test(f))).toBe(true);
    expect(d.redFlags.some((f) => /capacity/.test(f))).toBe(true);
  });

  it("not-found (404) is honest: found:false + note, no fabricated host", async () => {
    __setFetchForTest(async () => jsonResp({}, false, 404));
    const d = await hostDiagnostics({ address: "rNope" });
    expect(d.found).toBe(false);
    expect(d.address).toBe("rNope");
    expect(d.note).toMatch(/not found/i);
    expect(d.reputation).toBeUndefined();
    expect(d.slots).toBeUndefined();
  });

  it("empty record is honest: found:false + note", async () => {
    __setFetchForTest(async () => jsonResp({ something: "else" }));
    const d = await hostDiagnostics({ address: "rEmpty" });
    expect(d.found).toBe(false);
    expect(d.note).toMatch(/not found/i);
  });

  it("fetch failure is honest: found:false + note (no invented data)", async () => {
    __setFetchForTest(async () => { throw new Error("ECONNREFUSED"); });
    const d = await hostDiagnostics({ address: "rDown" });
    expect(d.found).toBe(false);
    expect(d.note).toMatch(/fetch failed: ECONNREFUSED/);
  });

  it("timeout/abort is reported distinctly", async () => {
    __setFetchForTest(async () => { const e = new Error("aborted"); e.name = "TimeoutError"; throw e; });
    const d = await hostDiagnostics({ address: "rSlow" });
    expect(d.found).toBe(false);
    expect(d.note).toMatch(/timed out/);
  });

  it("HTTP error (non-404) is honest", async () => {
    __setFetchForTest(async () => jsonResp({}, false, 503));
    const r = await fetchHostByAddress("rErr");
    expect(r.host).toBeUndefined();
    expect(r.note).toMatch(/HTTP 503/);
  });

  it("diagnoses a SUPPLIED host without any network call", async () => {
    let called = false;
    __setFetchForTest(async () => { called = true; return jsonResp({}); });
    const d = await hostDiagnostics({ host: { address: "rSupplied", hostReputation: 150, maxInstances: 4, activeInstances: 0 } });
    expect(called).toBe(false);
    expect(d.found).toBe(true);
    expect(d.slots?.available).toBe(4);
  });

  it("no address and no host: honest found:false, never invents a host", async () => {
    const d = await hostDiagnostics({});
    expect(d.found).toBe(false);
    expect(d.note).toMatch(/provide a host/i);
  });

  // Regression (adversarial verify 2026-06-15): a non-object JSON body (null / primitive / array)
  // must be reported as an honest empty record — NEVER a thrown TypeError surfaced as "fetch failed",
  // and never a fabricated host. (Bug found: `data.host` threw when the body was null.)
  it("null JSON body is honest empty (not a TypeError, no fabricated host)", async () => {
    __setFetchForTest(async () => jsonResp(null));
    const d = await hostDiagnostics({ address: "rNull" });
    expect(d.found).toBe(false);
    expect(d.note).toMatch(/not found|empty record/i);
    expect(d.note).not.toMatch(/Cannot read|TypeError|fetch failed/i);
    expect(d.reputation).toBeUndefined();
    expect(d.slots).toBeUndefined();
  });

  it("array JSON body is honest empty (no fabricated host)", async () => {
    __setFetchForTest(async () => jsonResp([{ address: "rSneaky" }]));
    const d = await hostDiagnostics({ address: "rArr" });
    expect(d.found).toBe(false);
    expect(d.note).toMatch(/empty record/i);
  });

  it("primitive JSON body is honest empty (no fabricated host)", async () => {
    __setFetchForTest(async () => jsonResp("ok"));
    const d = await hostDiagnostics({ address: "rStr" });
    expect(d.found).toBe(false);
    expect(d.note).toMatch(/empty record/i);
  });

  it("malformed JSON (json() throws) is honest found:false + note, no fabricated host", async () => {
    __setFetchForTest(async () => ({ ok: true, status: 200, json: async () => { throw new Error("Unexpected token"); } } as unknown as Response));
    const d = await hostDiagnostics({ address: "rBadJson" });
    expect(d.found).toBe(false);
    expect(d.reputation).toBeUndefined();
    expect(d.slots).toBeUndefined();
    expect(d.lease).toBeUndefined();
  });

  // NO-FABRICATION invariant, stated structurally: EVERY field emitted by diagnoseHost must trace
  // back to a key that was present in the source record. There is no input that adds an unsourced field.
  it("emits ONLY fields sourced from the record (no invented field for any present-key subset)", () => {
    const d = diagnoseHost({ address: "rTrace", hostReputation: 120, leaseDrops: 200000 });
    // present -> shown
    expect(d.reputation).toBe(120);
    expect(d.lease).toEqual({ leaseDrops: 200000 });
    // absent in source -> absent in output (never defaulted/guessed)
    expect(d.specs).toBeUndefined();
    expect(d.slots).toBeUndefined();
    expect(d.lease?.evrPerMoment).toBeUndefined();
    expect(d.registration?.version).toBeUndefined();
    expect(d.registration?.countryCode).toBeUndefined();
  });

  it("caches a successful lookup within TTL (no refetch)", async () => {
    let calls = 0;
    __setFetchForTest(async () => { calls++; return jsonResp({ address: "rCache", hostReputation: 100 }); });
    await hostDiagnostics({ address: "rCache" });
    const second = await hostDiagnostics({ address: "rCache" });
    expect(calls).toBe(1);
    expect(second.note).toMatch(/cache/);
  });
});
