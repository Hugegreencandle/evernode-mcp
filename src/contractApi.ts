// HotPocket contract-API usage checker.
//
// A SEPARATE concern from determinism (src/determinism.ts): determinism asks "will this code
// compute the same thing on every node?"; THIS asks "does this code use the HotPocket contract
// API correctly at all?" — does it register an entry point, read the contract context, persist
// through the consensused state mechanism (not arbitrary host files), handle user I/O, use the
// ledger clock for time, and await its async consensus ops.
//
// Like check_determinism this is a HEURISTIC source scan (per-line regex + a few whole-source
// structural checks) — it has no type info and resolves no dynamic calls, so it can have false
// positives AND false negatives. It is GUIDANCE, NOT A PROOF. Treat HIGH findings as likely-broken
// until justified, but always confirm against the live HotPocket docs + a real cluster run.
//
// HotPocket Node.js contract model (hotpocket-nodejs-contract): you construct a
// `new HotPocket.Contract()` and call `hpc.init(contractFn)`. HotPocket invokes `contractFn(ctx)`
// once per consensus round; `ctx` carries `lclSeqNo` (the deterministic clock), `users` (the
// connected users + their inputs, read via async `ctx.users.read(input)` and replied via async
// `user.send(...)`), and (when enabled) `ctx.npl` for the Node Party Line. The ONLY persistence
// that is subject to consensus is the contract's state file in its working dir — writing to
// arbitrary host paths diverges across nodes.

export type Severity = "high" | "medium" | "low";
export interface ApiFinding {
  line: number;       // 1-based; 0 for whole-source (structural) findings
  column: number;     // 1-based; 0 for whole-source findings
  snippet: string;
  rule: string;
  severity: Severity;
  why: string;
  fix: string;
}

// A per-line rule. Whole-source structural checks are handled separately below.
interface LineRule {
  id: string;
  re: RegExp;
  severity: Severity;
  why: string;
  fix: string;
  // optional: SUPPRESS the finding (provably-correct use). Heuristic only.
  suppress?: (line: string, m: RegExpExecArray, src: string) => boolean;
}

// Reuse the determinism scanner's comment stripper semantics: drop a `//` line comment only when
// it's OUTSIDE a string/template literal, so a `//` inside a URL doesn't truncate real code.
function stripLineComment(line: string): string {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === "\\") { i++; continue; }
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'" || c === "`") {
      quote = c;
    } else if (c === "/" && line[i + 1] === "/") {
      return line.slice(0, i);
    }
  }
  return line;
}

// True if the fs write/read targets the sanctioned consensused state file (state.json / a *.json
// state file) rather than an arbitrary host path. Heuristic: look at the first string arg.
function fsTargetsStateFile(line: string, m: RegExpExecArray): boolean {
  const after = line.slice(m.index + m[0].length);
  // first string literal argument
  const sm = /["'`]([^"'`]*)["'`]/.exec(after);
  if (!sm) return false;
  const path = sm[1];
  // Accept a relative *.json in the working dir (the consensused state file). Reject absolute
  // paths and anything reaching outside the cwd (/, .., ~, /tmp, /etc, os.tmpdir-style).
  if (/^(?:\/|~|\.\.|[A-Za-z]:\\)/.test(path)) return false;
  if (/\/tmp\/|\/etc\/|\/var\/|node_modules/.test(path)) return false;
  return /\.json$/.test(path) || /state/i.test(path);
}

const LINE_RULES: LineRule[] = [
  // Arbitrary fs write/read to a NON-state path: state persisted outside the consensused mechanism
  // diverges across nodes AND isn't replicated. (Determinism flags fs too, but from the
  // "non-deterministic" angle; here it's the API-correctness angle: use the state file.)
  { id: "fs-outside-state",
    re: /\bfs(?:\.promises)?\.(?:writeFile|writeFileSync|appendFile|appendFileSync|readFile|readFileSync|mkdir|mkdirSync|rm|rmSync|unlink|unlinkSync)\s*\(/,
    severity: "high",
    why: "Persisting outside the contract's consensused state mechanism: an arbitrary host-path read/write isn't replicated across the cluster and differs per node, so state diverges and consensus breaks.",
    fix: "Persist ONLY through the consensused state file in the contract's working dir (e.g. a single state.json read/written via your state helper). Don't touch arbitrary or absolute host paths.",
    suppress: (line, m) => fsTargetsStateFile(line, m) },

  // ctx.users.read(...) without an await on the same line — it's async; a missing await yields a
  // Promise (often "[object Promise]") instead of the input bytes, and order isn't sequenced.
  { id: "missing-await-read",
    re: /(?<!await\s)(?<!await\s{2})\bctx\.users\.read\s*\(/,
    severity: "high",
    why: "ctx.users.read(input) is ASYNC — without `await` you get a pending Promise, not the input bytes, and the consensus round may advance before the read resolves.",
    fix: "Await it: `const buf = await ctx.users.read(input);` (then `.toString()` / JSON.parse the bytes).",
    suppress: (line) => /\bawait\s+ctx\.users\.read\s*\(/.test(line) },

  // user.send(...) / *.send(...) reply without await — async; a missing await can drop the reply
  // when the round ends, and leaves an unhandled rejection on error.
  { id: "missing-await-send",
    re: /\b(?:user|u)\.send\s*\(/,
    severity: "medium",
    why: "user.send(...) is ASYNC — without `await` the reply may not flush before the consensus round ends, and a rejection goes unhandled.",
    fix: "Await each reply: `await user.send(JSON.stringify(...));`.",
    suppress: (line) => /\bawait\s+(?:user|u)\.send\s*\(/.test(line) || /\breturn\s+(?:user|u)\.send\s*\(/.test(line) },

  // Date.now / new Date for time instead of ctx.lclSeqNo. (Cross-refs determinism's wall-clock
  // rule, but framed here as 'wrong API for the HotPocket clock'.)
  { id: "time-not-lclseqno",
    re: /\b(?:Date\.now|performance\.now)\s*\(|new\s+Date\s*\(\s*\)/,
    severity: "high",
    why: "Reading the host wall clock for time instead of the HotPocket consensus clock — each node reads its own clock so the value isn't consensused (also flagged by check_determinism).",
    fix: "Use ctx.lclSeqNo (the last-closed ledger sequence) as the deterministic clock; count rounds instead of reading Date/performance." },
];

// Whole-source structural checks (not line-anchored). Each returns a finding or null.
function structuralChecks(src: string): ApiFinding[] {
  const out: ApiFinding[] = [];
  const code = src.split(/\r?\n/).map(stripLineComment).join("\n");

  // 1) Must register an entry point: `hpc.init(...)` (or `<x>.init(...)` on a HotPocket.Contract()).
  const hasContractCtor = /\bnew\s+HotPocket\.Contract\s*\(/.test(code);
  const hasInit = /\.\s*init\s*\(/.test(code);
  if (!hasInit) {
    out.push({
      line: 0, column: 0, snippet: "(whole source)", rule: "missing-init",
      severity: "high",
      why: "No HotPocket contract entry point found: a contract must call `hpc.init(contractFn)` on a `new HotPocket.Contract()` so HotPocket invokes it each consensus round. Without it the contract never runs.",
      fix: "Add the entry point: `const hpc = new HotPocket.Contract(); hpc.init(contractFn);` where contractFn is `async (ctx) => { ... }`.",
    });
  } else if (!hasContractCtor) {
    out.push({
      line: 0, column: 0, snippet: "(whole source)", rule: "init-without-contract",
      severity: "medium",
      why: "An `.init(...)` call was found but no `new HotPocket.Contract()` — the entry point may not be wired to the HotPocket runtime.",
      fix: "Construct the contract first: `const hpc = new HotPocket.Contract(); hpc.init(contractFn);` (import HotPocket from 'hotpocket-nodejs-contract').",
    });
  }

  // 2) Must read ctx (the contract context) — at least one of lclSeqNo / users / npl.
  const readsCtx = /\bctx\.(?:lclSeqNo|users|npl|unl|contractId|publicKey|readonly)\b/.test(code);
  if (!readsCtx) {
    out.push({
      line: 0, column: 0, snippet: "(whole source)", rule: "ignores-ctx",
      severity: "high",
      why: "The contract never reads its context (`ctx.users` / `ctx.lclSeqNo` / `ctx.npl`). A HotPocket contract that ignores ctx can't see user inputs or the deterministic clock — it does no useful consensused work.",
      fix: "Use ctx: iterate `ctx.users.list()` and read inputs via `await ctx.users.read(input)`; use `ctx.lclSeqNo` as the clock.",
    });
  }

  // 3) If it reads users, it should handle user I/O (list + read + a send reply path).
  const usesUsers = /\bctx\.users\b/.test(code);
  if (usesUsers) {
    const listsUsers = /\bctx\.users\.list\s*\(/.test(code);
    const readsInput = /\bctx\.users\.read\s*\(/.test(code);
    const sends = /\.send\s*\(/.test(code);
    if (!listsUsers) {
      out.push({
        line: 0, column: 0, snippet: "(whole source)", rule: "users-not-listed",
        severity: "medium",
        why: "ctx.users is referenced but `ctx.users.list()` is never called — there's no loop over the connected users to read their inputs.",
        fix: "Iterate users each round: `for (const user of ctx.users.list()) { for (const input of user.inputs) { const buf = await ctx.users.read(input); ... } }`.",
      });
    }
    if (listsUsers && !readsInput) {
      out.push({
        line: 0, column: 0, snippet: "(whole source)", rule: "inputs-not-read",
        severity: "medium",
        why: "Users are listed but their inputs are never read via `ctx.users.read(input)` — the contract sees connections but not what they sent.",
        fix: "Read each input: `const buf = await ctx.users.read(input);` then parse the bytes.",
      });
    }
    if (!sends) {
      out.push({
        line: 0, column: 0, snippet: "(whole source)", rule: "no-user-reply",
        severity: "low",
        why: "User inputs are handled but the contract never replies via `user.send(...)` — clients get no response (acceptable for fire-and-forget, but usually a mistake).",
        fix: "Reply to the user: `await user.send(JSON.stringify(result));` (skip only if a one-way contract is intended).",
      });
    }
  }

  return out;
}

export function checkContractApi(source: string): { findings: ApiFinding[]; summary: string } {
  const findings: ApiFinding[] = [];
  const lines = source.split(/\r?\n/);
  const stripped = lines.map(stripLineComment);

  lines.forEach((raw, idx) => {
    const line = stripped[idx];
    for (const rule of LINE_RULES) {
      const m = rule.re.exec(line);
      if (m) {
        if (rule.suppress && rule.suppress(line, m, source)) continue;
        findings.push({
          line: idx + 1,
          column: (m.index ?? 0) + 1,
          snippet: raw.trim().slice(0, 120),
          rule: rule.id,
          severity: rule.severity,
          why: rule.why,
          fix: rule.fix,
        });
      }
    }
  });

  findings.push(...structuralChecks(source));

  const high = findings.filter((f) => f.severity === "high").length;
  const med = findings.filter((f) => f.severity === "medium").length;
  const low = findings.filter((f) => f.severity === "low").length;
  const summary = findings.length === 0
    ? "No HotPocket contract-API misuse detected (heuristic). This is guidance, not a proof — confirm against the live HotPocket docs and a real cluster run."
    : `${findings.length} potential contract-API issue(s): ${high} high, ${med} medium, ${low} low. ` +
      `Heuristic guidance, not a proof — HIGH findings are likely broken; verify against the HotPocket docs.`;
  return { findings, summary };
}
