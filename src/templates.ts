// HotPocket dApp templates. Each returns a file set (contract + config + client + package.json)
// that is DETERMINISTIC by construction — no wall-clock, no randomness, no network in the
// contract path; time is the consensus ledger seq (ctx.lclSeqNo); state persists through the
// contract's own consensused state file. (They are written to pass src/determinism.ts.)
//
// HotPocket contract model recap: HotPocket invokes your function once per consensus round
// with `ctx` { lclSeqNo, users{ list(), read(input), ... } }. You read user inputs, mutate
// state, and reply with user.send(...). Same inputs -> same state/outputs on every node.

export interface FileSet {
  template: string;
  files: Record<string, string>;
  notes: string[];
}

const STATE_HELPER = `// state.js — the ONLY persistence: a JSON file in the contract's working dir, which
// HotPocket subjects to consensus. Deterministic across nodes given identical inputs.
// (A determinism scan will flag fs here; this single sanctioned state file is the exception.)
import fs from "fs";
const FILE = "state.json";
export function load(initial) {
  try { return JSON.parse(fs.readFileSync(FILE, "utf8")); } catch { return structuredClone(initial); }
}
export function save(state) { fs.writeFileSync(FILE, JSON.stringify(state)); }
`;

const CFG = JSON.stringify({ contract: { bin_path: "/usr/bin/node", bin_args: "index.js" } }, null, 2);

const PKG = (name: string) => JSON.stringify({
  name, version: "0.1.0", type: "module", main: "index.js",
  scripts: { start: "hpdevkit deploy dist", build: "echo no-build" },
  dependencies: { "hotpocket-nodejs-contract": "*" },
}, null, 2);

const CLIENT = `import HotPocket from "hotpocket-js-client";
import fs from "fs";

async function main() {
  const keyFile = "user.key";
  if (!fs.existsSync(keyFile))
    fs.writeFileSync(keyFile, Buffer.from((await HotPocket.generateKeys()).privateKey).toString("hex"));
  const kp = await HotPocket.generateKeys(fs.readFileSync(keyFile).toString());
  const client = await HotPocket.createClient(["wss://localhost:8081"], kp);
  if (!(await client.connect())) return console.log("connect failed");
  client.on(HotPocket.events.contractOutput, (r) => r.outputs.forEach((o) => console.log("<-", o.toString())));
  // Example: send one command then keep listening.
  await client.submitContractInput(JSON.stringify({ cmd: "status" }));
}
main();
`;

// helper: wrap a contract body that exposes (ctx, users, input json) handling
function contract(body: string): string {
  return `import HotPocket from "hotpocket-nodejs-contract";
import { load, save } from "./state.js";

const contractFn = async (ctx) => {
${body}
};

const hpc = new HotPocket.Contract();
hpc.init(contractFn);
`;
}

const TEMPLATES: Record<string, { body: string; notes: string[] }> = {
  blank: {
    body: `  // One invocation per consensus round. ctx.lclSeqNo is your deterministic clock.
  for (const user of ctx.users.list()) {
    for (const inp of user.inputs) {
      const msg = (await ctx.users.read(inp)).toString();
      await user.send(JSON.stringify({ echo: msg, ledger: ctx.lclSeqNo }));
    }
  }`,
    notes: ["Minimal echo contract. Use as a starting point."],
  },

  escrow: {
    body: `  // State-machine escrow: a depositor locks an amount-claim for a beneficiary, released
  // after a deadline expressed in LEDGER SEQUENCES (deterministic), or refunded.
  const s = load({ escrows: {}, nextId: 1 });
  for (const user of ctx.users.list()) {
    const who = user.publicKey;
    for (const inp of user.inputs) {
      let m; try { m = JSON.parse((await ctx.users.read(inp)).toString()); } catch { continue; }
      if (m.cmd === "create") {                       // {cmd, beneficiary, amount, releaseLedger}
        const id = s.nextId++;
        s.escrows[id] = { from: who, beneficiary: m.beneficiary, amount: m.amount,
                          releaseLedger: m.releaseLedger, status: "locked" };
        await user.send(JSON.stringify({ created: id }));
      } else if (m.cmd === "release") {               // {cmd, id} — only after releaseLedger
        const e = s.escrows[m.id];
        if (e && e.status === "locked" && ctx.lclSeqNo >= e.releaseLedger) {
          e.status = "released";
          await user.send(JSON.stringify({ released: m.id, to: e.beneficiary, amount: e.amount }));
        } else await user.send(JSON.stringify({ error: "not releasable yet" }));
      }
    }
  }
  save(s);`,
    notes: [
      "Deadlines are LEDGER SEQUENCES, not timestamps — the deterministic clock.",
      "This is the off-chain decision layer. Actual XAH/IOU settlement is a Xahau Payment emitted from the cluster's multisig account — wire that via the cluster's Xahau signer (see deploy notes), and consider an `xahc`-built guardrail Hook on that account.",
    ],
  },

  subscription: {
    body: `  // Subscription access: users 'subscribe' for N ledger-rounds; access is granted while
  // ctx.lclSeqNo < expiry. Pure ledger-seq accounting, fully deterministic.
  const s = load({ subs: {}, periodLedgers: 2592000 });   // ~ rounds per period; tune to roundtime
  for (const user of ctx.users.list()) {
    const who = user.publicKey;
    for (const inp of user.inputs) {
      let m; try { m = JSON.parse((await ctx.users.read(inp)).toString()); } catch { continue; }
      if (m.cmd === "subscribe") {
        const base = Math.max(ctx.lclSeqNo, s.subs[who]?.expiry ?? 0);
        s.subs[who] = { expiry: base + s.periodLedgers };
        await user.send(JSON.stringify({ subscribed: true, expiresAtLedger: s.subs[who].expiry }));
      } else if (m.cmd === "access") {
        const active = (s.subs[who]?.expiry ?? 0) > ctx.lclSeqNo;
        await user.send(JSON.stringify({ access: active }));
      }
    }
  }
  save(s);`,
    notes: ["Convert ledger-rounds to wall time using your configured consensus roundtime when quoting users a duration."],
  },

  game_backend: {
    body: `  // Turn-based game backend: per-user score, deterministic moves. No randomness — if you
  // need 'dice', derive them from a hash of (ledger seq + ordered inputs), never Math.random.
  const s = load({ scores: {} });
  for (const user of ctx.users.list()) {
    const who = user.publicKey;
    for (const inp of user.inputs) {
      let m; try { m = JSON.parse((await ctx.users.read(inp)).toString()); } catch { continue; }
      if (m.cmd === "move" && Number.isInteger(m.points)) {
        s.scores[who] = (s.scores[who] ?? 0) + m.points;
        await user.send(JSON.stringify({ score: s.scores[who] }));
      } else if (m.cmd === "leaderboard") {
        // tiebreaker MUST be a locale-INDEPENDENT code-point comparison — localeCompare uses the
        // host's ICU collation, which differs across nodes and would diverge the order (consensus).
        const board = Object.entries(s.scores).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
        await user.send(JSON.stringify({ leaderboard: board.slice(0, 10) }));
      }
    }
  }
  save(s);`,
    notes: ["Leaderboard sorts with a code-point (locale-INDEPENDENT) tiebreaker on public key so ordering is deterministic across nodes — never localeCompare (host ICU collation diverges)."],
  },

  voting: {
    body: `  // One-vote-per-pubkey poll. Tally is deterministic; votes keyed by public key dedupe.
  const s = load({ proposals: {}, nextId: 1 });
  for (const user of ctx.users.list()) {
    const who = user.publicKey;
    for (const inp of user.inputs) {
      let m; try { m = JSON.parse((await ctx.users.read(inp)).toString()); } catch { continue; }
      if (m.cmd === "propose") {
        const id = s.nextId++;
        s.proposals[id] = { title: String(m.title ?? ""), votes: {}, closeLedger: m.closeLedger ?? 0 };
        await user.send(JSON.stringify({ proposalId: id }));
      } else if (m.cmd === "vote") {                  // {cmd, id, choice:"yes"|"no"}
        const p = s.proposals[m.id];
        if (p && (p.closeLedger === 0 || ctx.lclSeqNo < p.closeLedger) && (m.choice === "yes" || m.choice === "no")) {
          p.votes[who] = m.choice;                     // keyed by pubkey -> one vote each
          await user.send(JSON.stringify({ ok: true }));
        } else await user.send(JSON.stringify({ error: "closed or invalid" }));
      } else if (m.cmd === "tally") {
        const p = s.proposals[m.id]; if (!p) { await user.send(JSON.stringify({ error: "no such proposal" })); continue; }
        const v = Object.keys(p.votes).sort().map((k) => p.votes[k]);  // sorted iteration -> deterministic
        await user.send(JSON.stringify({ yes: v.filter((x) => x === "yes").length, no: v.filter((x) => x === "no").length }));
      }
    }
  }
  save(s);`,
    notes: ["Votes are keyed by public key, so re-voting overwrites — one effective vote per identity."],
  },

  token_gated: {
    body: `  // Token-gated access. CAUTION: a balance lives on Xahau/XRPL, OUTSIDE this cluster.
  // You must NOT fetch it from contract logic (non-deterministic). Pattern: an off-contract
  // oracle (or the user) submits a SIGNED balance attestation that the nodes consensus on as
  // an input; here we gate on an allowlist the cluster admin maintains via consensused input.
  const s = load({ allow: {}, admin: null });
  for (const user of ctx.users.list()) {
    const who = user.publicKey;
    for (const inp of user.inputs) {
      let m; try { m = JSON.parse((await ctx.users.read(inp)).toString()); } catch { continue; }
      if (m.cmd === "init-admin" && !s.admin) { s.admin = who; await user.send(JSON.stringify({ admin: who })); }
      else if (m.cmd === "set-access" && who === s.admin) { s.allow[m.pubkey] = !!m.granted; await user.send(JSON.stringify({ ok: true })); }
      else if (m.cmd === "enter") { await user.send(JSON.stringify({ access: !!s.allow[who] })); }
    }
  }
  save(s);`,
    notes: [
      "On-chain balances can't be read deterministically from inside the contract.",
      "Use a consensused oracle/attestation input (or NPL agreement) to bring the token check in — the template gates on an admin-maintained allowlist as the safe default.",
    ],
  },

  oracle_consumer: {
    body: `  // Oracle consumer — the canonical HARD pattern done RIGHT. External data (a price, an
  // on-chain balance, a weather feed) must NEVER be fetched from contract logic: each node's
  // fetch would return a different value/timing and consensus breaks. The deterministic way is
  // an NPL AGREEMENT: every node proposes the value it observed off-contract (gathered OUTSIDE
  // the contract fn), the nodes exchange proposals over the Node Party Line, and they only ACT
  // on the value once a threshold AGREES on the same value. The agreed value enters state as a
  // consensused datum, identical on every node. (Feeding the off-contract observation in is done
  // by the node operator / a sidecar; the contract only consumes the AGREED result.)
  const s = load({ feed: {}, lastAgreedLedger: 0 });   // feed: { key -> { value, ledger } }
  // ctx.npl: HotPocket's Node Party Line. We propose our observed value and collect peers'.
  // Same threshold + same comparison on every node => the SAME agreed value or the SAME no-op.
  if (ctx.npl && typeof ctx.npl.send === "function") {
    for (const user of ctx.users.list()) {
      for (const inp of user.inputs) {
        let m; try { m = JSON.parse((await ctx.users.read(inp)).toString()); } catch { continue; }
        if (m.cmd === "observe" && typeof m.key === "string") {   // {cmd, key, value} from the node's sidecar
          // The agreed value must be a PRIMITIVE (a price/balance/string) so its canonical form is
          // byte-identical on every node — object key-order can't diverge if there's no object.
          const canon = (v) => (typeof v === "number" || typeof v === "boolean") ? String(v) : String(v ?? "");
          // 1) PROPOSE our observation to peers over NPL (never a fetch from here).
          await ctx.npl.send(canon(m.key) + "\\u0000" + canon(m.value));
          // 2) COLLECT peer proposals for this round (HotPocket delivers them deterministically).
          const proposals = [];
          if (typeof ctx.npl.read === "function") {
            for await (const p of ctx.npl.read()) {
              const [pk, pv] = p.toString().split("\\u0000");
              if (pk === canon(m.key)) proposals.push(pv);
            }
          }
          proposals.push(canon(m.value));   // include our own
          // 3) AGREE: a value is accepted only if a strict majority proposed the SAME value.
          //    Tally over a SORTED key view so the winner is deterministic on every node.
          const tally = {};
          for (const v of proposals) tally[v] = (tally[v] ?? 0) + 1;
          const need = Math.floor(proposals.length / 2) + 1;
          let agreed = null;
          for (const v of Object.keys(tally).sort()) { if (tally[v] >= need) { agreed = v; break; } }
          if (agreed !== null) {
            s.feed[m.key] = { value: agreed, ledger: ctx.lclSeqNo };
            s.lastAgreedLedger = ctx.lclSeqNo;
            await user.send(JSON.stringify({ agreed: true, key: m.key, value: agreed, ledger: ctx.lclSeqNo }));
          } else {
            await user.send(JSON.stringify({ agreed: false, reason: "no NPL majority on the value yet" }));
          }
        } else if (m.cmd === "read" && typeof m.key === "string") {   // consume the last AGREED datum
          await user.send(JSON.stringify({ key: m.key, datum: s.feed[m.key] ?? null }));
        }
      }
    }
  } else {
    // NPL unavailable in this runtime config — DON'T silently fetch; report honestly.
    for (const user of ctx.users.list())
      for (const inp of user.inputs)
        await user.send(JSON.stringify({ error: "NPL not available — enable it (hp.cfg npl=public) so nodes can AGREE on the value; never fetch from contract logic" }));
  }
  save(s);`,
    notes: [
      "EXTERNAL DATA THE DETERMINISTIC WAY: nodes AGREE on the value via NPL (Node Party Line) before acting — they NEVER fetch it from contract logic (a fetch returns a different value/timing per node and stalls consensus).",
      "The node's off-contract sidecar observes the value and submits it as the `observe` input; the contract only PROPOSES + AGREES + consumes — it does no network I/O itself.",
      "A value is accepted only on a strict NPL majority of identical proposals; ties/disagreement are a deterministic no-op (same on every node), surfaced honestly, never guessed.",
      "Agreed values are PRIMITIVES (price/balance/string) so their canonical form is byte-identical across nodes — never agree on a raw object (key order can diverge); encode structured data as a sorted/canonical string before agreement.",
      "Enable NPL in hp.cfg (`npl: \"public\"`); the agreed datum is stamped with ctx.lclSeqNo (the deterministic clock), not a wall-clock time.",
    ],
  },

  streaming_payment: {
    body: `  // Streaming payment — per-ledger-seq vesting. The releasable amount is a PURE FUNCTION of
  // the consensus clock: release = f(ctx.lclSeqNo). No wall-clock, no timers — every node
  // computes the identical vested amount for a given ledger. This contract only RECORDS the
  // accounting (how much has vested / been claimed); the actual XAH/IOU transfer is DEFERRED to
  // the cluster's Xahau multisig step (see generate_settlement) — the contract never moves value.
  const s = load({ streams: {}, nextId: 1 });   // streams: { id -> {to, total, startLedger, durationLedgers, claimed} }
  for (const user of ctx.users.list()) {
    const who = user.publicKey;
    for (const inp of user.inputs) {
      let m; try { m = JSON.parse((await ctx.users.read(inp)).toString()); } catch { continue; }
      // vested(stream, ledger): linear vesting in DROPS, clamped to [0, total]. Integer math only
      // (no floats) so the result is byte-identical across nodes.
      const vested = (st, ledger) => {
        if (ledger <= st.startLedger) return 0;
        const elapsed = ledger - st.startLedger;
        if (elapsed >= st.durationLedgers) return st.total;
        return Math.floor((st.total * elapsed) / st.durationLedgers);   // integer drops
      };
      if (m.cmd === "create" && Number.isInteger(m.total) && Number.isInteger(m.durationLedgers) && m.durationLedgers > 0) {
        const id = s.nextId++;
        s.streams[id] = { from: who, to: String(m.to), total: m.total,
                          startLedger: ctx.lclSeqNo, durationLedgers: m.durationLedgers, claimed: 0 };
        await user.send(JSON.stringify({ created: id, startLedger: ctx.lclSeqNo }));
      } else if (m.cmd === "status" && s.streams[m.id]) {   // pure read: vested as of THIS ledger
        const st = s.streams[m.id];
        const v = vested(st, ctx.lclSeqNo);
        await user.send(JSON.stringify({ id: m.id, vested: v, claimed: st.claimed, claimable: v - st.claimed, ledger: ctx.lclSeqNo }));
      } else if (m.cmd === "claim" && s.streams[m.id]) {   // RECORD a release; transfer is deferred
        const st = s.streams[m.id];
        const claimable = vested(st, ctx.lclSeqNo) - st.claimed;
        if (claimable > 0) {
          st.claimed += claimable;
          // record the payout intent; settlement (the actual Xahau Payment) is a separate
          // multisig step via generate_settlement — the contract does NOT transfer here.
          await user.send(JSON.stringify({ recorded: true, id: m.id, payout: { destination: st.to, drops: claimable }, ledger: ctx.lclSeqNo,
                                           note: "release recorded — settle via the cluster Xahau multisig (generate_settlement)" }));
        } else await user.send(JSON.stringify({ recorded: false, reason: "nothing vested to claim yet" }));
      }
    }
  }
  save(s);`,
    notes: [
      "Vesting is release = f(ctx.lclSeqNo): a PURE function of the consensus clock — no wall-clock, no timers, integer drops only, so every node computes the identical vested amount.",
      "Durations are LEDGER SEQUENCES, not seconds — convert using your configured roundtime when quoting users a wall-clock duration.",
      "The contract only RECORDS the release (claimed accounting + a payout intent); the actual XAH/IOU transfer is DEFERRED to the cluster's Xahau multisig step — wire it via generate_settlement.",
    ],
  },

  multisig_treasury: {
    body: `  // Multisig treasury — records spend PROPOSALS and APPROVALS (M-of-N threshold) under
  // consensus. When approvals reach the threshold the proposal is marked 'approved' and the
  // contract EMITS the settlement step (a Xahau multisig Payment via generate_settlement). The
  // contract decides WHAT to pay and WHO approved; it never signs or moves value itself.
  const s = load({ signers: [], threshold: 0, proposals: {}, nextId: 1 });
  for (const user of ctx.users.list()) {
    const who = user.publicKey;
    for (const inp of user.inputs) {
      let m; try { m = JSON.parse((await ctx.users.read(inp)).toString()); } catch { continue; }
      if (m.cmd === "init" && s.signers.length === 0 && Array.isArray(m.signers) && Number.isInteger(m.threshold)) {
        // configure once: the signer pubkey set + the M-of-N threshold. Store signers SORTED
        // so any later iteration over them is deterministic across nodes.
        s.signers = [...new Set(m.signers.map(String))].sort();
        s.threshold = Math.max(1, Math.min(m.threshold, s.signers.length));
        await user.send(JSON.stringify({ initialized: true, signers: s.signers, threshold: s.threshold }));
      } else if (m.cmd === "propose" && s.signers.includes(who)) {   // {cmd, destination, drops}
        const id = s.nextId++;
        s.proposals[id] = { destination: String(m.destination), drops: Number(m.drops) || 0,
                            approvals: {}, status: "open", proposedBy: who, ledger: ctx.lclSeqNo };
        s.proposals[id].approvals[who] = true;   // proposing implies approving
        await user.send(JSON.stringify({ proposalId: id, approvals: 1, threshold: s.threshold }));
      } else if (m.cmd === "approve" && s.signers.includes(who)) {   // {cmd, id}
        const p = s.proposals[m.id];
        if (!p || p.status !== "open") { await user.send(JSON.stringify({ error: "no open proposal" })); continue; }
        p.approvals[who] = true;
        // count approvals over a SORTED key view -> deterministic threshold check on every node.
        const count = Object.keys(p.approvals).sort().filter((k) => p.approvals[k]).length;
        if (count >= s.threshold) {
          p.status = "approved";
          // THRESHOLD MET -> emit the settlement step. The contract records the approved payout;
          // the actual Xahau multisig Payment + the PROVEN agent_guardrail Hook come from
          // generate_settlement (template: "multisig_treasury"). The contract never signs/spends.
          await user.send(JSON.stringify({ approved: true, id: m.id, count, threshold: s.threshold,
                                           settle: { destination: p.destination, drops: p.drops },
                                           note: "threshold met — emit the Xahau multisig settlement via generate_settlement (the Hook enforces the cap at layer 1)" }));
        } else {
          await user.send(JSON.stringify({ approved: false, id: m.id, count, threshold: s.threshold }));
        }
      } else if (m.cmd === "status" && s.proposals[m.id]) {
        const p = s.proposals[m.id];
        const count = Object.keys(p.approvals).sort().filter((k) => p.approvals[k]).length;
        await user.send(JSON.stringify({ id: m.id, status: p.status, approvals: count, threshold: s.threshold, destination: p.destination, drops: p.drops }));
      }
    }
  }
  save(s);`,
    notes: [
      "Records spend PROPOSALS + M-of-N APPROVALS under consensus; approvals are keyed by signer pubkey (one each) and counted over a SORTED key view so the threshold check is deterministic on every node.",
      "When approvals reach the threshold the contract EMITS the settlement step — the actual Xahau multisig Payment + the PROVEN agent_guardrail Hook come from generate_settlement (template: \"multisig_treasury\"); the contract never signs or moves value.",
      "Ties the trifecta in: pair with an `xahc` guardrail Hook on the treasury account + an `xahc-prover` spend-limit/conservation proof — the ledger enforces the per-tx cap even if the off-chain approval logic is wrong.",
    ],
  },

  payment_splitter: {
    body: `  // Payment splitter: records incoming deposits and computes deterministic splits by weight.
  // The SETTLEMENT (actual XAH/IOU payouts) is emitted from the cluster's Xahau multisig
  // account — this contract decides the amounts; a separate signer step submits the payments.
  const s = load({ recipients: [], pending: [] });   // recipients: [{addr, weight}]
  for (const user of ctx.users.list()) {
    const who = user.publicKey;
    for (const inp of user.inputs) {
      let m; try { m = JSON.parse((await ctx.users.read(inp)).toString()); } catch { continue; }
      if (m.cmd === "set-recipients" && Array.isArray(m.recipients)) {
        s.recipients = m.recipients.map((r) => ({ addr: String(r.addr), weight: Number(r.weight) || 0 }));
        await user.send(JSON.stringify({ ok: true }));
      } else if (m.cmd === "deposit" && Number.isInteger(m.drops)) {
        const total = s.recipients.reduce((a, r) => a + r.weight, 0) || 1;
        let allocated = 0;
        const split = s.recipients.map((r, i) => {
          // integer drops; give the remainder to the last recipient so the sum is exact
          const amt = i === s.recipients.length - 1 ? m.drops - allocated
                                                     : Math.floor((m.drops * r.weight) / total);
          allocated += amt; return { addr: r.addr, drops: amt };
        });
        s.pending.push({ ledger: ctx.lclSeqNo, from: who, split });
        await user.send(JSON.stringify({ split }));
      }
    }
  }
  save(s);`,
    notes: [
      "Integer drops only; the remainder goes to the last recipient so payouts sum EXACTLY (no rounding leak).",
      "Settlement is a separate Xahau multisig payment step — pair with an `xahc` guardrail Hook + `xahc-prover` balance-conservation proof for safety.",
    ],
  },
};

export function listTemplates(): string[] {
  return Object.keys(TEMPLATES);
}

export function generate(template: string, name = "mycontract"): FileSet {
  const t = TEMPLATES[template];
  if (!t) throw new Error(`unknown template '${template}'. one of: ${listTemplates().join(", ")}`);
  return {
    template,
    files: {
      "src/index.js": contract(t.body),
      "src/state.js": STATE_HELPER,
      "dist/hp.cfg.override": CFG,
      "package.json": PKG(name),
      "client/client.js": CLIENT,
    },
    notes: [
      `Scaffold with: hpdevkit gen nodejs blank-contract ${name}  (then replace src with these files), or drop these in directly.`,
      "Run locally: npm install && npm start  (hpdevkit deploys to a local 3-node cluster).",
      ...t.notes,
      "Before deploy: run check_determinism on src/index.js — HIGH findings break consensus.",
    ],
  };
}
