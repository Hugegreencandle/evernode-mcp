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
        const board = Object.entries(s.scores).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
        await user.send(JSON.stringify({ leaderboard: board.slice(0, 10) }));
      }
    }
  }
  save(s);`,
    notes: ["Leaderboard sorts with a tiebreaker on public key so ordering is deterministic across nodes."],
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
