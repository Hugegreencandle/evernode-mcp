// Pattern advisor, EVR lease estimator, host ranking, deploy-command generator, and an
// error explainer. Pure logic + honest data sourcing (no fabricated host data or fees).

// ---- HotPocket pattern advice -------------------------------------------------
export function recommendPattern(useCase: string): { pattern: string; nodes: string; notes: string[] } {
  const u = useCase.toLowerCase();
  const notes: string[] = [];
  let nodes = "multi-node cluster (3+ nodes) — Byzantine fault tolerance needs ≥3 so one bad/offline node can't stall or corrupt state";
  let pattern = "Stateful consensus contract: read user inputs each round, mutate the consensused state file, reply via user.send.";

  if (/(test|prototype|demo|learn|local)/.test(u)) {
    nodes = "start on the local hpdevkit 3-node cluster; lease real hosts only when ready";
  }
  if (/(oracle|price|external|fetch|api|off-chain data|balance|token-gat)/.test(u)) {
    notes.push("EXTERNAL DATA: never fetch from contract logic (non-deterministic). Use an oracle pattern — an off-contract feeder submits a SIGNED value as a user input that all nodes consensus on, or nodes agree a value via NPL before acting.");
  }
  if (/(coordinat|leader|agree|random|shuffle|deal|lottery)/.test(u)) {
    notes.push("NPL (Node Party Line): use it when nodes must agree on something not derivable from inputs alone (e.g. a shared random seed). Derive randomness from a hash of consensused data, never Math.random.");
  }
  if (/(pay|xah|iou|settle|escrow|split|withdraw|transfer)/.test(u)) {
    notes.push("XAHAU SETTLEMENT: the cluster holds a Xahau multisig account; value moves by EMITTING a Xahau Payment from it after the contract decides amounts. Guard that account with an `xahc` Hook and prove the spend rule with `xahc-prover` (limit / balance-conservation).");
  }
  if (/(single|simple|stateless|one node)/.test(u)) {
    nodes = "single node is possible for non-critical/stateless tasks, but you lose fault tolerance — prefer ≥3 for anything holding value or state.";
  }
  notes.push("State lives ONLY in the contract's consensused state file. Time = ledger sequence (ctx.lclSeqNo), never the wall clock.");
  return { pattern, nodes, notes };
}

// ---- EVR lease estimate -------------------------------------------------------
// Evernode tenants pay a host a per-Moment lease in EVR. There is NO standard rate — each
// host sets its own (often a fraction of an EVR/Moment). A Moment is a fixed Xahau-ledger
// window (host-configured; commonly ~1 hour). Registration fees (≥500 EVR) are paid by
// HOSTS, not tenants — so they're excluded from a tenant lease estimate.
export function estimateLease(opts: { evrPerMoment: number; moments: number; nodes: number; momentMinutes?: number }) {
  const { evrPerMoment, moments, nodes } = opts;
  const momentMinutes = opts.momentMinutes ?? 60;
  if (![evrPerMoment, moments, nodes].every((n) => Number.isFinite(n) && n >= 0)) {
    throw new Error("evrPerMoment, moments, nodes must be non-negative numbers");
  }
  const perNode = evrPerMoment * moments;
  const total = perNode * nodes;
  const wallHours = (moments * momentMinutes) / 60;
  return {
    inputs: { evrPerMoment, moments, nodes, momentMinutes },
    perNodeEVR: perNode,
    totalEVR: total,
    approxDurationHours: wallHours,
    notes: [
      "EVR/Moment is host-set — there is no network standard. Get the real rate from the host's lease offer (evdevkit / XRPLWin) before trusting an estimate.",
      "Registration fees (≥500 EVR) are paid by HOSTS, not tenants — not included here.",
      "A Moment is a fixed ledger window (commonly ~1h); confirm the host's moment size.",
      `Total = evrPerMoment × moments × nodes = ${evrPerMoment} × ${moments} × ${nodes} = ${total} EVR over ~${wallHours}h.`,
    ],
  };
}

// ---- Host data (live from OnLedger; ranks REAL data — never invents hosts) ----
// OnLedger (api.onledger.net) is a public, no-auth, real-time index of Evernode hosts queried
// from the Xahau registry hook. We fetch live and/or rank a list you supply. We never
// fabricate host addresses or specs. (XRPLWin / evdevkit are alternative live sources.)
export type Prefer = "cheap" | "capacity" | "reputation";
export interface HostRow {
  address: string; leaseAmount?: number; leaseDrops?: number; availableInstances?: number;
  maxInstances?: number; activeInstances?: number; hostReputation?: number; ramMb?: number;
  diskMb?: number; countryCode?: string; version?: string; hostingType?: string; flagged?: number;
}

const ONLEDGER = "https://api.onledger.net";
const PREFER_SORT: Record<Prefer, string> = {
  cheap: "leaseDrops:asc",                 // lowest EVR/moment first
  capacity: "availableInstances:desc",     // most free slots first
  reputation: "hostReputation:desc",       // highest reputation (the network's liveness/quality signal)
};

function mapHost(h: Record<string, unknown>): HostRow {
  return {
    address: String(h.address), leaseAmount: h.leaseAmount != null ? Number(h.leaseAmount) : undefined,
    leaseDrops: h.leaseDrops as number, availableInstances: h.availableInstances as number,
    maxInstances: h.maxInstances as number, activeInstances: h.activeInstances as number,
    hostReputation: h.hostReputation as number, ramMb: h.ramMb as number, diskMb: h.diskMb as number,
    countryCode: h.countryCode as string, version: h.version as string,
    hostingType: h.hostingType as string, flagged: h.flagged as number,
  };
}

// Fetch live, already-ranked hosts from OnLedger. Honest on failure (no fabricated fallback).
export async function fetchHostsLive(opts: { prefer?: Prefer; minRep?: number; minSlots?: number; country?: string; minRam?: number; limit?: number; }):
  Promise<{ hosts: HostRow[]; source: string; query: string; note?: string }> {
  const prefer = opts.prefer ?? "cheap";
  const p = new URLSearchParams({ active: "true", sort: PREFER_SORT[prefer], limit: String(opts.limit ?? 10) });
  p.set("minSlots", String(opts.minSlots ?? 1));
  if (opts.minRep != null) p.set("minRep", String(opts.minRep));
  if (opts.country) p.set("country", opts.country);
  if (opts.minRam != null) p.set("minRam", String(opts.minRam));
  const url = `${ONLEDGER}/hosts?${p.toString()}`;
  try {
    const r = await fetch(url, { headers: { accept: "application/json" } });
    if (!r.ok) return { hosts: [], source: "api.onledger.net", query: url, note: `OnLedger returned HTTP ${r.status}` };
    const data = (await r.json()) as { hosts?: Record<string, unknown>[] };
    return { hosts: (data.hosts ?? []).map(mapHost), source: "api.onledger.net", query: url };
  } catch (e) {
    return { hosts: [], source: "api.onledger.net", query: url, note: `fetch failed: ${(e as Error).message}` };
  }
}

// Rank a SUPPLIED list (when the caller already has host data and just wants it ordered).
export function rankHosts(hosts: HostRow[], prefer: Prefer = "cheap") {
  if (!Array.isArray(hosts) || hosts.length === 0) {
    return { ranked: [], note: "No host data supplied. Omit `hosts` to fetch live from OnLedger, or pass a real list. This tool ranks real data; it never invents hosts." };
  }
  const free = (h: HostRow) => h.availableInstances ?? ((h.maxInstances ?? 0) - (h.activeInstances ?? 0));
  const score = (h: HostRow) =>
    prefer === "capacity" ? free(h)
    : prefer === "reputation" ? (h.hostReputation ?? 0)
    : -(h.leaseDrops ?? (h.leaseAmount != null ? h.leaseAmount * 1e6 : Number.POSITIVE_INFINITY));
  const ranked = [...hosts].filter((h) => !h.flagged && (free(h) > 0 || prefer === "reputation"))
    .sort((a, b) => score(b) - score(a)).slice(0, 10);
  return { ranked, prefer, note: `Ranked ${ranked.length} host(s) by '${prefer}'. Verify recent liveness/reputation before acquiring a lease.` };
}

// Orchestrator used by the MCP tool: rank a supplied list, else fetch live from OnLedger.
export async function recommendHosts(opts: { hosts?: HostRow[]; prefer?: Prefer; minRep?: number; minSlots?: number; country?: string; minRam?: number; limit?: number; }) {
  if (opts.hosts && opts.hosts.length) return { mode: "ranked-supplied", ...rankHosts(opts.hosts, opts.prefer) };
  const live = await fetchHostsLive(opts);
  return { mode: "live-onledger", source: live.source, query: live.query, note: live.note, prefer: opts.prefer ?? "cheap", ranked: live.hosts };
}

// ---- Deploy command generator -------------------------------------------------
export function deployCommands(opts: { mode: "local" | "single" | "cluster" | "cluster-manager"; host?: string; nodes?: number; instanceName?: string }) {
  const name = opts.instanceName ?? "mycontract";
  const n = opts.nodes ?? 3;
  switch (opts.mode) {
    case "local":
      return { steps: [
        "# Local 3-node dev cluster (no real hosts, no EVR):",
        `hpdevkit gen nodejs blank-contract ${name}`,
        `cd ${name} && npm install`,
        "npm start            # builds + deploys dist/ to the local cluster",
        "hpdevkit logs 1      # tail node 1",
        "hpdevkit stop        # stop the cluster",
      ], notes: ["Iterate here until check_determinism is clean and behavior is right, THEN lease real hosts."] };
    case "single":
      return { steps: [
        "# Acquire ONE real instance on a chosen host (needs an EVR-funded tenant Xahau account):",
        "export EV_USER_PRIVATE_KEY=...   # tenant key (evdevkit keygen to create one)",
        `evdevkit acquire ${opts.host ?? "<HOST_XAHAU_ADDRESS>"} -m <moments>`,
        `evdevkit deploy ./dist <instance-ip>:<user-port> <instance-pubkey>`,
      ], notes: ["Get a host address + lease rate from XRPLWin / OnLedger first (use recommend_hosts).", "EVR is spent here — confirm the lease cost with estimate_lease_cost."] };
    case "cluster":
      return { steps: [
        `# Lease + deploy a ${n}-node cluster with evdevkit:`,
        "export EV_USER_PRIVATE_KEY=...",
        `evdevkit cluster create ${n} -m <moments>   # acquires ${n} instances`,
        "evdevkit cluster deploy ./dist              # deploys the contract to all nodes",
        "evdevkit cluster status",
      ], notes: ["For value-holding clusters use ≥3 nodes. Extend leases before they expire or instances are reclaimed."] };
    case "cluster-manager":
      return { steps: [
        "# Use Offledger's Cluster Manager (a hosted GUI/service) — connect to it, don't replace it:",
        "1. Build + dist your contract locally (npm run build / npm start to validate on hpdevkit).",
        "2. Run check_determinism until clean.",
        "3. In Offledger Cluster Manager: create a cluster, point it at your dist bundle / repo, set node count + lease budget.",
        "4. Let Cluster Manager handle acquire/deploy/lease-renewal; this MCP advises (templates, checks, cost), it does not take over orchestration.",
      ], notes: ["Offledger Cluster Manager owns the deploy/lifecycle; evernode-mcp complements it (generate + check + cost + explain)."] };
  }
}

// ---- Error explainer ----------------------------------------------------------
const ERRORS: { match: RegExp; cause: string; fix: string }[] = [
  { match: /connection failed|connect failed|websocket|ECONNREFUSED|wss:\/\/localhost/i,
    cause: "Client can't reach the HotPocket node (not running, wrong port, or TLS).",
    fix: "Ensure the cluster is up (`npm start` / `hpdevkit logs 1`); default user port is 8081; HotPocket uses wss:// (self-signed locally — the JS client accepts it)." },
  { match: /consensus|ledger.*not.*creat|stall|nodes.*disagree|state.*mismatch|hash mismatch/i,
    cause: "Consensus stalled or nodes diverged — almost always NON-DETERMINISTIC contract code (different output per node).",
    fix: "Run check_determinism on your contract. Remove Date.now/Math.random/network/env reads; use ctx.lclSeqNo for time and consensused inputs for everything external." },
  { match: /no hosts|host.*unavailable|acquire.*fail|no offer|lease.*reject/i,
    cause: "No suitable/active host offer found, or the host rejected the lease.",
    fix: "Pick an active host with free capacity from XRPLWin/OnLedger (recommend_hosts), confirm its lease rate, and ensure your tenant account holds enough EVR." },
  { match: /insufficient.*evr|not enough evr|balance.*evr|tecUNFUNDED|tecINSUF/i,
    cause: "Tenant Xahau account lacks the EVR (or XAH for fees) to pay the lease.",
    fix: "Fund the tenant account with EVR; estimate the need with estimate_lease_cost (evrPerMoment × moments × nodes). XAH is also needed for Xahau tx fees." },
  { match: /lease.*expire|instance.*reclaim|moment.*end|expired/i,
    cause: "The lease ran out and the instance was reclaimed by the host.",
    fix: "Extend the lease before expiry (evdevkit extend / Cluster Manager auto-renew). Persist nothing you can't rebuild; clusters self-heal by re-leasing replacement nodes." },
  { match: /docker|container|image.*pull|sashimono/i,
    cause: "Local Docker / Sashimono image issue (HotPocket runs in Docker).",
    fix: "Ensure Docker is running and the HotPocket image pulled; `hpdevkit` manages local containers — retry after `docker info` succeeds." },
  { match: /_g|guard|GUARD_VIOLATION|hook.*reject|tecHOOK/i,
    cause: "A Xahau HOOK on the cluster's account rejected the settlement transaction (this is the Hook layer, not HotPocket).",
    fix: "Use the trifecta: `xahau-mcp` to simulate the tx against the hook, and `xahc-prover` to prove the spend invariant. A GUARD_VIOLATION means a guarded loop exceeded its budget." },
];
export function explainError(text: string) {
  const hits = ERRORS.filter((e) => e.match.test(text));
  if (hits.length === 0)
    return { matched: false, message: "No known pattern matched. If it's a consensus/ledger stall, suspect non-determinism first (run check_determinism)." };
  return { matched: true, explanations: hits.map((h) => ({ cause: h.cause, fix: h.fix })) };
}
