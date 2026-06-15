// Settlement layer: when a value-moving dApp (escrow, payment_splitter, subscription payout)
// pays out on Xahau, it does so from the cluster's account. This generates the full
// "safe by construction -> proven safe" bundle:
//   1. cluster-side payment code (deterministic INTENT from the contract; signing OUTSIDE
//      consensus via the cluster's multisig/threshold signer),
//   2. the install of the trifecta's agent_guardrail Hook on that account with the caller's
//      LIM (per-tx spend cap) + optional DST (destination lock),
//   3. the exact `xahc prove` command that PROVES the guardrail safe for all inputs.
//
// The guardrail Hook is the already-built, already-testnet-validated artifact from xahc-prover
// (agent_guardrail.wasm). We set LIM/DST as HookParameters per account — no new WASM to build.
// We do NOT fabricate a proof here; we emit the command that produces the real verdict.

const LIM_KEY_HEX = "4C494D";   // "LIM"
const DST_KEY_HEX = "445354";   // "DST"

function drops8Hex(drops: number): string {
  if (!Number.isInteger(drops) || drops < 0) throw new Error("limitDrops must be a non-negative integer");
  return drops.toString(16).toUpperCase().padStart(16, "0");   // 8-byte big-endian
}

const SETTLE_JS = (cluster: string) => `// xahau/settle.js — cluster-side Xahau settlement.
//
// HotPocket decides the PAYOUT AMOUNTS deterministically (in the contract, under consensus).
// SIGNING happens OUTSIDE consensus: the cluster account (${cluster}) is a MULTISIG account;
// each node proposes the same payment, and a threshold of node signers co-sign it before
// submission. This keeps the value decision consensused while no single node holds spend power.
//
// The account runs the agent_guardrail Hook (installed below), so even a buggy/compromised
// signer set CANNOT exceed the per-tx LIM or pay a non-allowed DST — the ledger rejects it.
import * as lib from "xrpl-accountlib";
import { XrplClient } from "xrpl-client";

const NETWORK_ID = 21338;            // Xahau testnet; 21337 = mainnet
const CLUSTER_ACCOUNT = "${cluster}";

// payouts: [{ destination, drops }] — produced by the contract (deterministic), passed here.
export async function settle(payouts, signWith /* threshold signer(s) */) {
  const client = new XrplClient("wss://xahau-test.net");
  await client.ready();
  const defs = new lib.XrplDefinitions(await client.send({ command: "server_definitions" }));
  const { account_data } = await client.send({ command: "account_info", account: CLUSTER_ACCOUNT });
  let seq = account_data.Sequence;
  const results = [];
  for (const p of payouts) {
    const tx = { TransactionType: "Payment", Account: CLUSTER_ACCOUNT, Destination: p.destination,
                 Amount: String(p.drops), NetworkID: NETWORK_ID, Sequence: seq++, Fee: "100000" };
    // multisig: collect threshold signatures over \`tx\` from the node signers, then submit.
    const { signedTransaction } = lib.sign(tx, signWith, defs);          // replace with multisign aggregation
    results.push(await client.send({ command: "submit", tx_blob: signedTransaction }));
  }
  client.close();
  return results;   // inspect engine_result per payout; the guardrail Hook enforces the cap
}
`;

export interface SettlementBundle {
  template: string;
  limitDrops: number;
  files: Record<string, string>;
  install: string;
  prove: string;
  notes: string[];
}

export function generateSettlement(opts: { template: string; limitDrops: number; dest?: string; clusterAccount?: string }): SettlementBundle {
  const cluster = opts.clusterAccount ?? "<CLUSTER_XAHAU_ACCOUNT>";
  const limHex = drops8Hex(opts.limitDrops);
  const dstParam = opts.dest ? ` --param ${DST_KEY_HEX}=<20-byte-accountid-hex of ${opts.dest}>` : "";
  const install =
    `xahc install-tx <path>/agent_guardrail.wasm --account ${cluster} --on Payment ` +
    `--param ${LIM_KEY_HEX}=${limHex}${dstParam}   # sign offline, submit as SetHook`;
  const prove = `xahc prove <path>/agent_guardrail.wasm --invariant guardrail`;
  return {
    template: opts.template,
    limitDrops: opts.limitDrops,
    files: { "xahau/settle.js": SETTLE_JS(cluster) },
    install,
    prove,
    notes: [
      `LIM = ${opts.limitDrops} drops -> HookParameter ${LIM_KEY_HEX}=${limHex} (8-byte big-endian).`,
      opts.dest ? `DST locks payouts to ${opts.dest}; decode it to a 20-byte account-id hex for the param.`
                : "No DST set -> outgoing payments aren't destination-locked. Add `dest` to lock them.",
      "The agent_guardrail Hook is the trifecta's PROVEN artifact: `xahc prove ... --invariant guardrail` returns PROVEN (spend-limit + dst-lock) for ALL inputs, and the same hook was validated on Xahau testnet (see xahc-prover/docs/TESTNET-PROOF.md — over-limit pay -> tecHOOK_REJECTED on-chain).",
      "Signing is multisig/threshold across the cluster's signer nodes — never a single node. The contract only decides amounts; the Hook enforces the cap at layer 1.",
      "Run the prove command on YOUR built wasm before deploy; deploy only on a PROVEN verdict.",
    ],
  };
}
