// Fetch-hardening tests for the live OnLedger path. We inject a fake fetch (no real network) to
// exercise success/caching, HTTP error, network failure, and abort/timeout — all of which must
// stay HONEST: empty hosts + a clear note, never fabricated host data.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { fetchHostsLive, recommendHosts, __setFetchForTest, __clearHostCache } from "../dist/advisor.js";

beforeEach(() => __clearHostCache());
afterEach(() => __setFetchForTest(null));

function jsonResp(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body } as unknown as Response;
}

describe("fetchHostsLive hardening", () => {
  it("maps a successful response and passes a timeout AbortSignal", async () => {
    let sawSignal = false;
    __setFetchForTest(async (_url, init) => {
      sawSignal = !!(init && (init as RequestInit).signal);
      return jsonResp({ hosts: [{ address: "rLive", leaseDrops: 7, availableInstances: 1 }] });
    });
    const r = await fetchHostsLive({ prefer: "cheap" });
    expect(sawSignal).toBe(true);
    expect(r.hosts.map((h) => h.address)).toEqual(["rLive"]);
    expect(r.note).toBeUndefined();
  });

  it("is honest on HTTP error: empty hosts + note, no fabrication", async () => {
    __setFetchForTest(async () => jsonResp({}, false, 503));
    const r = await fetchHostsLive({});
    expect(r.hosts).toHaveLength(0);
    expect(r.note).toMatch(/HTTP 503/);
  });

  it("is honest on network failure: empty hosts + note", async () => {
    __setFetchForTest(async () => { throw new Error("ECONNREFUSED"); });
    const r = await fetchHostsLive({});
    expect(r.hosts).toHaveLength(0);
    expect(r.note).toMatch(/fetch failed: ECONNREFUSED/);
  });

  it("reports a timeout/abort distinctly (no hang, no unhandled rejection)", async () => {
    __setFetchForTest(async () => {
      const e = new Error("aborted"); e.name = "TimeoutError"; throw e;
    });
    const r = await fetchHostsLive({});
    expect(r.hosts).toHaveLength(0);
    expect(r.note).toMatch(/timed out/);
  });

  it("caches a successful query and does not refetch within TTL", async () => {
    let calls = 0;
    __setFetchForTest(async () => { calls++; return jsonResp({ hosts: [{ address: "rCache" }] }); });
    const a = await fetchHostsLive({ prefer: "reputation" });
    const b = await fetchHostsLive({ prefer: "reputation" });
    expect(calls).toBe(1);
    expect(a.hosts[0].address).toBe("rCache");
    expect(b.hosts[0].address).toBe("rCache");
    expect(b.note).toMatch(/cache/);
  });

  it("does NOT cache failures (retries on next call)", async () => {
    let calls = 0;
    __setFetchForTest(async () => { calls++; return jsonResp({}, false, 500); });
    await fetchHostsLive({ prefer: "cheap" });
    await fetchHostsLive({ prefer: "cheap" });
    expect(calls).toBe(2);
  });

  it("recommendHosts live path surfaces the failure note honestly", async () => {
    __setFetchForTest(async () => { throw new Error("boom"); });
    const r = await recommendHosts({ prefer: "cheap" });
    expect(r.mode).toBe("live-onledger");
    expect(r.ranked).toHaveLength(0);
    expect(r.note).toMatch(/fetch failed: boom/);
  });
});
