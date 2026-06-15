// Determinism checker for HotPocket contracts.
//
// HotPocket runs your contract on EVERY node of the cluster and puts the OUTPUT + state
// through consensus. If two nodes compute different results, consensus breaks and the
// ledger stalls. So a HotPocket contract MUST be deterministic: same inputs -> same outputs
// on every node, every time. This is the #1 mistake new HotPocket devs make.
//
// This is a HEURISTIC source scan (regex-based, no full parse) — it flags the well-known
// non-deterministic sources. It can have false positives (e.g. a `Date.now()` only used for
// a local log) and can't catch every case (it does not resolve aliases or dynamic calls), so
// it is guidance, NOT a proof. Treat every HIGH finding as a consensus risk until justified.

export type Severity = "high" | "medium" | "low";
export interface Finding {
  line: number;
  column: number;
  snippet: string;
  rule: string;
  severity: Severity;
  why: string;
  fix: string;
}

interface Rule {
  id: string;
  re: RegExp;
  severity: Severity;
  why: string;
  fix: string;
  // optional: given the stripped line + the regex match, return true to SUPPRESS the finding
  // (a provably-deterministic use). Heuristic only — used to avoid flagging sorted iteration.
  suppress?: (line: string, m: RegExpExecArray) => boolean;
}

// True when an `Object.keys|values|entries(...)` match is immediately followed by `.sort(`
// on the same line, i.e. the iteration order is provably sorted (deterministic).
// Heuristic: walks from just after the match, balancing the (...) of the Object.* call, and
// checks the next token is `.sort(`. Anything we can't prove sorted falls through to a finding.
function objectIterIsSorted(line: string, m: RegExpExecArray): boolean {
  // find the '(' that opens the Object.* call argument list
  let i = m.index + m[0].length - 1; // m[0] ends at the '(' for these patterns
  if (line[i] !== "(") {
    i = line.indexOf("(", m.index);
    if (i === -1) return false;
  }
  let depth = 0;
  for (; i < line.length; i++) {
    const c = line[i];
    if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth === 0) { // closed the Object.* call — check what immediately follows
        const rest = line.slice(i + 1);
        return /^\s*\.sort\s*\(/.test(rest);
      }
    }
  }
  return false;
}

// Each rule's regex is matched per line. `\b` guards reduce obvious false matches.
const RULES: Rule[] = [
  { id: "wall-clock-time", re: /\b(Date\.now|performance\.now|process\.hrtime(?:\.bigint)?)\s*\(|new\s+Date\s*\(\s*\)/,
    severity: "high",
    why: "Wall-clock time differs across nodes — each reads its own clock, so the value isn't consensused.",
    fix: "Use the consensus ledger as your clock: HotPocket's contract context (e.g. ctx.lclSeqNo, or a consensus timestamp passed through NPL). Never read the node's local clock." },
  { id: "randomness", re: /\bMath\.random\s*\(|crypto\.(randomBytes|randomUUID|randomInt|randomFillSync|randomFill|getRandomValues)\s*\(|\brandomUUID\s*\(/,
    severity: "high",
    why: "Each node generates different random bytes — output diverges and consensus fails.",
    fix: "Derive randomness deterministically from consensused data (e.g. hash of the ledger seq + inputs), or coordinate a seed across nodes via NPL before use." },
  { id: "network-io", re: /\b(fetch|axios|got|node-fetch)\s*\(|require\(['"](https?|node:https?|net|dns|node:net|node:dns)['"]\)|from\s+['"](https?|node:https?|net|dns)['"]/,
    severity: "high",
    why: "Outbound network calls return different results/timing per node (and may fail on some) — non-deterministic and side-effectful inside consensus.",
    fix: "Do NOT call the network from contract logic. Bring external data in as a consensused USER INPUT, or via an oracle pattern where nodes agree on the value through NPL before acting." },
  { id: "node-env",
    re: /\bprocess\.env\b|\bprocess\.pid\b|\bos\.(hostname|networkInterfaces|cpus|freemem|loadavg|uptime|userInfo|platform|arch|tmpdir|endianness)\s*\(/,
    severity: "high",
    why: "Per-node environment (env vars, pid, hostname, machine stats) differs between hosts in the cluster.",
    fix: "Keep contract behavior independent of the host environment. Pass any needed config in via the consensused contract state or inputs, not process/os." },
  { id: "timers", re: /\b(setTimeout|setInterval|setImmediate)\s*\(/,
    severity: "medium",
    why: "Timer firing order/timing isn't consensused; relying on it for state changes diverges across nodes.",
    fix: "HotPocket is invoked once per consensus round — model time by counting rounds (ledger seq), not by timers." },
  { id: "race", re: /\bPromise\.(race|any)\s*\(/,
    severity: "medium",
    why: "Promise.race/any resolves to whichever settles first — ordering can differ across nodes.",
    fix: "Use Promise.all and process results in a fixed, deterministic order." },
  { id: "unordered-iteration", re: /\bfor\s*\(\s*const\s+\w+\s+in\s+/,
    severity: "low",
    why: "`for..in` enumeration order can vary for keys that aren't plain string-insertion order; risky if the object was built from non-deterministic data.",
    fix: "Iterate a sorted key array: `for (const k of Object.keys(obj).sort())`." },
  { id: "iteration-order",
    re: /\bObject\.(keys|values|entries)\s*\(|\bfor\s*\(\s*const\s+(?:\[[^\]]*\]|\w+)\s+of\s+[^)]*\b(?:Map|Set)\b/,
    severity: "low",
    why: "Object key enumeration and Map/Set iteration follow insertion order — deterministic ONLY if every key was inserted in a consensused order on every node. If the source object was built from unordered/host-varying data, the resulting order (and any order-dependent result) diverges.",
    fix: "Iterate a sorted view: `for (const k of Object.keys(obj).sort())`, or `Object.entries(obj).sort(...)`. For Map/Set, materialize and sort: `[...map.keys()].sort()`. Order-independent reductions (a pure count/sum) are safe but the scanner can't prove that — sort to be certain.",
    suppress: (line, m) => m[0].startsWith("Object.") && objectIterIsSorted(line, m) },
  { id: "filesystem", re: /\bfs\.(readFile|readFileSync|readdir|readdirSync|writeFile|writeFileSync|stat|statSync)\s*\(/,
    severity: "medium",
    why: "Reading/writing host files outside HotPocket's consensused state dir introduces per-node differences.",
    fix: "Persist state only through HotPocket's state mechanism (the contract's state files under consensus). Don't touch arbitrary host paths." },
  { id: "weak-equality-ts", re: /\bDate\s*\(\s*\)/,
    severity: "low",
    why: "A bare Date() call reads the local clock.",
    fix: "Use the consensus ledger time, not Date()." },
];

// Strip a trailing line comment, but ONLY a `//` that is OUTSIDE a string/template literal.
// A naive indexOf("//") truncates at the `//` inside a URL literal ("http://…"), silently
// dropping any consensus-breaker after it on the same line (e.g. `log("http://x"); Date.now()`)
// — a false negative, the worst failure for this checker. We scan char-by-char tracking quote
// state; if a quote is left open at EOL (multi-line template), we keep the whole line (fail
// toward scanning more code, never toward dropping it).
function stripLineComment(line: string): string {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === "\\") { i++; continue; }          // skip the escaped char
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'" || c === "`") {
      quote = c;
    } else if (c === "/" && line[i + 1] === "/") {
      return line.slice(0, i);                     // `//` outside any string = real comment
    }
  }
  return line;
}

export function checkDeterminism(source: string): { findings: Finding[]; summary: string } {
  const findings: Finding[] = [];
  const lines = source.split(/\r?\n/);
  lines.forEach((raw, idx) => {
    const line = stripLineComment(raw);
    for (const rule of RULES) {
      const m = rule.re.exec(line);
      if (m) {
        if (rule.suppress && rule.suppress(line, m)) continue;
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
  const high = findings.filter((f) => f.severity === "high").length;
  const med = findings.filter((f) => f.severity === "medium").length;
  const low = findings.filter((f) => f.severity === "low").length;
  const summary = findings.length === 0
    ? "No non-deterministic patterns detected (heuristic). Still test on a multi-node cluster before mainnet."
    : `${findings.length} potential determinism issue(s): ${high} high, ${med} medium, ${low} low. ` +
      `HIGH findings are likely consensus breakers — resolve before deploying to a cluster.`;
  return { findings, summary };
}
