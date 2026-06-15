// Determinism checker for HotPocket contracts.
//
// HotPocket runs your contract on EVERY node of the cluster and puts the OUTPUT + state
// through consensus. If two nodes compute different results, consensus breaks and the
// ledger stalls. So a HotPocket contract MUST be deterministic: same inputs -> same outputs
// on every node, every time. This is the #1 mistake new HotPocket devs make.
//
// This is a HEURISTIC source scan (mostly per-line regex, plus a small cross-line alias pass) —
// it flags the well-known non-deterministic sources. It can have false POSITIVES (e.g. a
// `Date.now()` only used for a local log, or an order-independent reduction over a Map) and it
// still can't catch every case (it does not do full data-flow or resolve dynamic calls), so it
// is guidance, NOT a proof. Treat every HIGH finding as a consensus risk until justified.
//
// DESIGN BIAS (deliberate): for this tool a FALSE-NEGATIVE (silently missing a real consensus
// breaker) is the worst outcome — it ships a contract that stalls a cluster. A false-positive
// (flagging safe code) only costs the dev a justification. So when a construct *could* iterate an
// unordered collection but we can't prove it sorted, we FLAG it. Sorted views are recognized and
// suppressed; everything else order-sensitive falls through to a finding.

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

// Balance the (...) or [...] opened at/after `m` and return what immediately follows the close.
// Used to check whether a `.sort(` is chained onto a spread/Array.from materialization.
function restAfterBalanced(line: string, startIdx: number): string | null {
  // find the first bracket opener at/after startIdx
  let i = startIdx;
  while (i < line.length && line[i] !== "(" && line[i] !== "[") i++;
  if (i >= line.length) return null;
  const open = line[i];
  const close = open === "(" ? ")" : "]";
  let depth = 0;
  for (; i < line.length; i++) {
    const c = line[i];
    if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return line.slice(i + 1);
    }
  }
  return null; // unbalanced on this line — caller treats as "not provably sorted"
}

// True when a spread `[...X]` or `Array.from(X)` is immediately `.sort(`-ed (deterministic order).
function materializeIsSorted(line: string, m: RegExpExecArray): boolean {
  // For `[...` the outer bracket is the array literal; for `Array.from(` it's the call paren.
  // Walk from the match start, balance the FIRST opener, then check the remainder for `.sort(`.
  const rest = restAfterBalanced(line, m.index);
  return rest != null && /^\s*\.sort\s*\(/.test(rest);
}

// Heuristic safety check for JSON.stringify(...). We SUPPRESS only when we can see the order is
// pinned or irrelevant; anything we can't classify falls through to a (low) finding — never silent.
function jsonStringifyIsSafe(line: string, m: RegExpExecArray): boolean {
  // index of the '(' that opens the stringify call
  let i = m.index + m[0].length - 1;
  if (line[i] !== "(") { i = line.indexOf("(", m.index); if (i === -1) return false; }
  // grab the argument substring up to the balanced close (best-effort, single line)
  let depth = 0, end = -1;
  for (let j = i; j < line.length; j++) {
    const c = line[j];
    if (c === "(") depth++;
    else if (c === ")") { depth--; if (depth === 0) { end = j; break; } }
  }
  const args = end === -1 ? line.slice(i + 1) : line.slice(i + 1, end);
  const first = args.trimStart();
  // Safe: stringifying an ARRAY literal (array order is preserved, deterministic).
  if (first.startsWith("[")) return true;
  // Safe: stringifying a primitive literal (string/number/boolean/template).
  if (/^["'`]/.test(first) || /^-?\d/.test(first) || /^(true|false|null)\b/.test(first)) return true;
  // Safe: an OBJECT LITERAL `{ a: x, b: y }` — its key order is fixed lexically (same on every node),
  // UNLESS it splices keys in via a spread `...x` (then the injected keys follow the spread source's
  // order, which may not be consensused — so a literal containing `...` is NOT auto-safe).
  if (first.startsWith("{") && !/\.\.\./.test(args)) return true;
  // Safe: a replacer ARRAY is passed as the 2nd arg — keys are explicitly pinned + ordered.
  // crude top-level comma split (good enough; misses nested commas but only ADDS findings if wrong).
  if (/,\s*\[/.test(args)) return true;
  // Safe: object built via `.sort(` somewhere in the argument (e.g. fromEntries(entries.sort(...))).
  if (/\.sort\s*\(/.test(args)) return true;
  // Otherwise: a bare object identifier, a spread/merge, or a `{...}` with a spread — key order
  // isn't provably consensused. FLAG (low) rather than risk a silent miss.
  return false;
}

// ---- cross-line alias pass: Map/Set reached through a variable OR a member --------------------
// The per-line rules catch Map/Set named ON the iteration line (`for (..of new Map())`). The audit
// flagged the alias gap: `const m = new Map(); ... for (const x of m) {}`. We do a tiny pre-pass to
// learn which identifiers/members were assigned a `new Map(`/`new Set(`, then flag iteration/
// materialization over those on later lines. This is intentionally conservative-toward-flagging: we
// don't try to prove the alias is sorted (a var can't be `.sort()`-ed in place), so any such use is
// reported (low). Reassignment isn't tracked (a name seen as a Map alias STAYS flagged) — that can
// over-flag, which is the acceptable direction.
//
// TWO alias shapes are learned, both SOUND (evidence the binding holds a Map/Set):
//   1. a simple identifier:  `const m = new Map()`   -> tracked id "m"
//   2. a member assignment:  `this.m = new Set()`, `state.m = new Map()`, `obj.m = new Map()`
//      -> tracked member "this.m" / "state.m" / "obj.m". This closes the audit-flagged member case
//      (`for (const x of this.m) {}`) without unsound name-guessing: we only flag a member we SAW
//      assigned a Map/Set. (Bare members with no such evidence are handled by the per-line rule
//      below with a known-array allowlist, never by this evidence-based pass.)
function collectMapSetAliases(strippedLines: string[]): Set<string> {
  const aliases = new Set<string>();
  // identifier:  const|let|var X = new Map/Set
  const declId = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*new\s+(?:Map|Set)\b/g;
  // member:      this.X = / state.X = / obj.X = new Map/Set   (and chained: a.b.X = new Map())
  const declMember = /\b((?:this|[A-Za-z_$][\w$]*)(?:\.[A-Za-z_$][\w$]*)+)\s*=\s*new\s+(?:Map|Set)\b/g;
  for (const line of strippedLines) {
    let m: RegExpExecArray | null;
    declId.lastIndex = 0;
    while ((m = declId.exec(line))) aliases.add(m[1]);
    declMember.lastIndex = 0;
    while ((m = declMember.exec(line))) aliases.add(m[1]);
  }
  return aliases;
}

// Given the alias set, find an order-sensitive use of any alias on a line. Returns the column
// (1-based) of the match, or 0 if none. We match: for..of over the alias, spread `[...alias]`,
// `Array.from(alias`, `alias.forEach(`, and `alias.entries()/keys()/values()` (the iterators).
// Works for both identifier aliases ("m") and member aliases ("this.m"/"state.m").
function aliasIterColumn(line: string, aliases: Set<string>): number {
  for (const a of aliases) {
    const id = a.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // A member alias ("this.m") must NOT be preceded by another `.` (so `x.this.m` doesn't match a
    // "this.m" alias); a plain `\b` is fine for identifiers. Use a negative look-behind-ish guard via
    // a preceding non-`.` boundary baked into each pattern's leading context.
    const lead = a.includes(".") ? "(?<![.\\w$])" : "\\b";
    // The spread/Array.from contexts already begin with `...`/`(`, so the alias there is unambiguous
    // — they don't need (and must NOT use) the dot look-behind (the `...` ends in a `.`, which would
    // wrongly block a member alias like `[...state.s]`). The for..of/forEach/iterator contexts do
    // use `lead` to avoid matching a member alias as the tail of a longer member chain (`x.this.m`).
    const pats: RegExp[] = [
      new RegExp(`\\bfor\\s+await\\s*\\(\\s*(?:const|let|var)\\s+(?:\\[[^\\]]*\\]|[\\w$]+)\\s+of\\s+${lead}${id}\\b`),
      new RegExp(`\\bfor\\s*\\(\\s*(?:const|let|var)\\s+(?:\\[[^\\]]*\\]|[\\w$]+)\\s+of\\s+${lead}${id}\\b`),
      new RegExp(`\\[\\s*\\.\\.\\.\\s*${id}\\b`),
      new RegExp(`\\bArray\\.from\\s*\\(\\s*${id}\\b`),
      new RegExp(`${lead}${id}\\.forEach\\s*\\(`),
      new RegExp(`${lead}${id}\\.(?:entries|keys|values)\\s*\\(`),
    ];
    for (const re of pats) {
      const m = re.exec(line);
      if (m) return m.index + 1;
    }
  }
  return 0;
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
    // `process.env`/`process.pid` plus the idiomatic bare `process.*` host reads — `process.platform`/
    // `process.arch` (host CPU/OS), `process.cwd()`/`process.uptime()`/`process.memoryUsage()` (per-node
    // runtime state), `process.argv`/`process.ppid`/`process.getuid()`/`process.getgid()`/`process.title`
    // (per-invocation/per-process), and `process.version(s)` (host node build). A `\b` boundary matches
    // BOTH the property form (`process.platform`) and the call form (`process.cwd()`). `process.hrtime`
    // is deliberately NOT here — it's a clock and is owned by the `wall-clock-time` rule above. Plus the
    // `os.*` host-stat functions.
    re: /\bprocess\.env\b|\bprocess\.(?:pid|ppid|platform|arch|argv|cwd|uptime|memoryUsage|getuid|getgid|title|version|versions)\b|\bos\.(hostname|networkInterfaces|cpus|freemem|loadavg|uptime|userInfo|platform|arch|tmpdir|endianness)\s*\(/,
    severity: "high",
    why: "Per-node environment (env vars, pid, platform/arch, cwd, uptime, memory, argv, hostname, machine stats) differs between hosts in the cluster.",
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
  // .forEach over an Object.keys/values/entries view OR an inline `new Map/Set`. forEach visits in
  // iteration (insertion) order just like for..of — same divergence risk, previously a blind spot.
  { id: "iteration-order-foreach",
    re: /\bObject\.(keys|values|entries)\s*\([^)]*\)\s*\.forEach\s*\(|\bnew\s+(?:Map|Set)\s*\([^;]*\)\s*\.forEach\s*\(/,
    severity: "low",
    why: ".forEach visits elements in iteration (insertion) order — identical to for..of. Over an Object view or a Map/Set built from unordered data, any order-dependent side effect (e.g. building a string/array, accumulating with order-sensitive ops) diverges across nodes.",
    fix: "Sort first, then forEach: `Object.keys(obj).sort().forEach(...)`, or `[...map.entries()].sort(...).forEach(...)`. Pure order-independent accumulation is safe but unprovable here — sort to be certain.",
    suppress: (line, m) => m[0].startsWith("Object.") && objectIterIsSorted(line, m) },
  // Spread of a Map/Set/Object-view, or Array.from(...) over one — materializes in insertion order
  // into an array that downstream code may index/serialize in that order. Previously invisible.
  { id: "iteration-order-materialize",
    re: /\[\s*\.\.\.\s*(?:new\s+(?:Map|Set)\b|Object\.(?:keys|values|entries)\s*\()|\bArray\.from\s*\(\s*(?:new\s+(?:Map|Set)\b|Object\.(?:keys|values|entries)\s*\()/,
    severity: "low",
    why: "Spreading or Array.from-ing a Map/Set (or an Object.keys/values/entries view) materializes it into an array in INSERTION order. If that array is then indexed, sliced, or serialized, the result depends on an order that can diverge across nodes when the source was built from unordered data.",
    fix: "Sort the materialized array before relying on its order: `[...map.keys()].sort()`, `Array.from(set).sort()`, `Object.entries(obj).sort(...)`. (A bare `new Set([...])` purely for de-dup with no order-dependence is safe, but the scanner can't prove that — sort or justify.)",
    // Suppress when a `.sort(` immediately follows the closing of the spread/Array.from expression.
    suppress: (line, m) => materializeIsSorted(line, m) },
  // JSON.stringify of a plain object (no replacer array/space pinning keys) — key order follows
  // insertion order, so two nodes that built the object in different orders emit different JSON.
  // This is a classic consensus breaker (the serialized state/output differs byte-for-byte).
  { id: "json-stringify-unordered",
    re: /\bJSON\.stringify\s*\(/,
    severity: "low",
    why: "JSON.stringify serializes object keys in INSERTION order. If the object was assembled from unordered/host-varying data (or merged in a non-consensused order), the resulting JSON string differs across nodes — and contract OUTPUT/state is consensused byte-for-byte, so this stalls the cluster.",
    fix: "Serialize deterministically: pass a sorted replacer key array `JSON.stringify(obj, Object.keys(obj).sort())`, or build the object via a sorted-key reduce, or use a stable-stringify. For arrays of primitives this is fine (array order is preserved); the risk is object key order from non-consensused construction.",
    // Suppress the most common provably-safe shapes: stringifying a primitive/array literal, a
    // freshly-built object literal on the same line (its key order is lexically fixed), or a call
    // that already passes a replacer array as the 2nd arg.
    suppress: (line, m) => jsonStringifyIsSafe(line, m) },
  // Locale / ICU / timezone formatting + collation. The result depends on the host's installed
  // locale + ICU data + (for time) timezone — all of which vary node-to-node. A consensus breaker
  // any time the formatted/compared value feeds state or output (and the scanner can't tell that it
  // doesn't, so it flags). Classic trap: sorting strings with localeCompare to "order a leaderboard".
  { id: "locale-timezone",
    re: /\.toLocale(?:String|DateString|TimeString)\s*\(|\.localeCompare\s*\(|\bIntl\./,
    severity: "medium",
    why: "Locale/ICU/timezone-dependent: toLocaleString/toLocaleDateString/toLocaleTimeString, localeCompare, and Intl.* use the HOST's locale + ICU collation/format data (and the host timezone) — which differ across cluster nodes, so the produced string or sort order diverges and consensus breaks.",
    fix: "Use locale-INDEPENDENT formatting: build strings from raw fields / fixed templates, and SORT with a code-point comparison (`a < b ? -1 : a > b ? 1 : 0`), never `localeCompare`. For time, format from the consensus ledger seq (ctx.lclSeqNo), never a locale/timezone-aware Date formatter." },
  // Floating-point literals / parseFloat feeding contract math. Non-integer float arithmetic can
  // round / produce NaN / -0 differently across JS engines (and accumulate divergently). SOUND +
  // low-noise because the templates deliberately use INTEGER drops only — a non-integer literal in a
  // contract is a real smell. We flag `parseFloat(` and a bare non-integer decimal literal (e.g.
  // `0.1`, `* 0.1`), guarding against dotted version-like tokens (`1.2.3`) and member access. We
  // also flag a NEGATIVE-exponent scientific literal (`1.5e-3`, `1e-3`, `5E-2`) — always a non-integer
  // fraction; a positive-exponent literal (`1.5e3` = 1500) stays unflagged since it's integer-valued.
  { id: "floating-point",
    re: /\bparseFloat\s*\(|(?<![\w$.])\d+\.\d+(?![\w.])|(?<![\w$.])\d+(?:\.\d+)?[eE]-\d+\b/,
    severity: "low",
    why: "Floating-point math is an engine-level non-determinism risk: non-integer float literals (or parseFloat) can round, produce NaN/-0, or accumulate differently across JS engines/versions running on different hosts — so a value derived from them can diverge across nodes.",
    fix: "Use INTEGER math only for consensused amounts (e.g. work in drops, not XAH): scale to integers, do `Math.floor(a * n / d)` style division, and avoid non-integer float literals / parseFloat in any value that feeds state or output." },
  // for..of over a BARE member expression (`this.m`, `state.m`, `obj.m`) whose binding we have NO
  // Map/Set evidence for (the alias pass handles the evidenced case). Order-unprovable: it could be
  // a Map/Set (insertion order, divergence risk) — flag-biased, so flag it (low). Suppress members
  // that are KNOWN deterministic arrays in the HotPocket contract API (e.g. `user.inputs`), and
  // suppress CALL expressions (`x.list()`) which this regex already excludes by requiring no `(`.
  { id: "iteration-order-member",
    re: /\bfor\s*\(\s*(?:const|let|var)\s+(?:\[[^\]]*\]|[\w$]+)\s+of\s+((?:this|[A-Za-z_$][\w$]*)(?:\.[A-Za-z_$][\w$]*)+)\s*\)/,
    severity: "low",
    why: "Iterating a member expression (e.g. `this.m` / `state.m`) with for..of: if the member holds a Map/Set, iteration follows INSERTION order, which is deterministic only if every node inserted in the same consensused order. The scanner can't prove the member isn't an unordered collection, so (flag-biased) it reports it.",
    fix: "If the member is a Map/Set, materialize + sort before iterating: `for (const k of [...this.m.keys()].sort())`. If it is genuinely an ordered array (e.g. a HotPocket `user.inputs` list), this is a safe false-positive — justify it.",
    // Suppress known-deterministic HotPocket array members so the templates stay clean and we don't
    // flood honest array iteration. `user.inputs` is an array delivered in a fixed order.
    suppress: (_line, m) => /(?:^|\.)(?:inputs|outputs)$/.test(m[1]) },
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

// Description for the cross-line aliased-Map/Set finding (shares the iteration-order class).
const ALIAS_WHY =
  "An identifier bound to `new Map()`/`new Set()` is iterated/spread/forEach'd/Array.from'd here. " +
  "Map/Set iteration is INSERTION order — deterministic only if every node inserted in the same " +
  "consensused order. The per-line rules miss this because the collection is reached through a " +
  "variable (alias), so it is flagged structurally instead.";
const ALIAS_FIX =
  "Materialize and sort before relying on order: `[...m.keys()].sort()` / `[...set].sort()`, then " +
  "iterate that. Pure order-independent reductions (count/sum) are safe but unprovable here — sort " +
  "to be certain, or justify the use.";

export function checkDeterminism(source: string): { findings: Finding[]; summary: string } {
  const findings: Finding[] = [];
  const lines = source.split(/\r?\n/);
  // First strip comments once (so both passes agree on what's real code), then learn Map/Set aliases.
  const stripped = lines.map(stripLineComment);
  const aliases = collectMapSetAliases(stripped);
  lines.forEach((raw, idx) => {
    const line = stripped[idx];
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
    // Cross-line alias pass: order-sensitive use of a known Map/Set alias on this line. Only add it
    // if a per-line iteration-order rule didn't already fire here (avoid double-reporting the same spot).
    if (aliases.size) {
      const col = aliasIterColumn(line, aliases);
      if (col) {
        const already = findings.some(
          (f) => f.line === idx + 1 && f.rule.startsWith("iteration-order"));
        if (!already) {
          findings.push({
            line: idx + 1, column: col, snippet: raw.trim().slice(0, 120),
            rule: "iteration-order-alias", severity: "low", why: ALIAS_WHY, fix: ALIAS_FIX,
          });
        }
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
