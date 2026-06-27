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
  // When true, match against the RAW (comment-stripped, string-INTACT) line instead of the codeView.
  // Used only by the network-io IMPORT form, whose signal is a module specifier inside a string
  // literal (`require('net')` / `from 'dns'`) — neutralizing that string would be a false-negative.
  raw?: boolean;
  // optional: given the stripped line + the regex match (+ the full stripped-line array and the
  // line index for multi-line lookahead), return true to SUPPRESS the finding (a provably-
  // deterministic use). Heuristic only — used to avoid flagging sorted iteration / canonicalization.
  suppress?: (line: string, m: RegExpExecArray, lines?: string[], idx?: number) => boolean;
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
function jsonStringifyIsSafe(line: string, m: RegExpExecArray, lines?: string[], idx?: number): boolean {
  // index of the '(' that opens the stringify call
  let i = m.index + m[0].length - 1;
  if (line[i] !== "(") { i = line.indexOf("(", m.index); if (i === -1) return false; }
  // Find the argument substring up to the BALANCED close. We count parens on NEUTRALIZED text
  // (string/template/regex contents blanked) so a `(`/`)` inside a literal can't throw the balance
  // off. THE INVARIANT (closes audits JSF-1/JSF-2/AUDIT-2/FN-REGEX): suppression only ever happens
  // on a CLEANLY-BALANCED, fully-parsed argument. Any ambiguity — unbalanced single line, a
  // multi-line gather that never balances, or an arg-split that can't resolve — FAILS TOWARD
  // FLAGGING (never a silent suppress, which would be a false-negative, the lint's cardinal sin).
  const nline = neutralizeStrings(line);
  let depth = 0, end = -1;
  for (let j = i; j < nline.length; j++) {
    if (nline[j] === "(") depth++;
    else if (nline[j] === ")") { depth--; if (depth === 0) { end = j; break; } }
  }
  let args: string | null = end === -1 ? null : line.slice(i + 1, end);

  if (end === -1 && lines && idx !== undefined) {
    // MULTI-LINE call: join a window from the opening `(` forward, neutralize (handles strings/
    // template literals/regex spanning lines), and find the MATCHING close paren — then slice the
    // inner argument BETWEEN the parens (exclude both). If it never balances -> args stays null ->
    // flag. (Excluding the trailing `)` matters: leaving it in makes topLevelArgs see depth<0.)
    const window = [lines[idx].slice(i), ...lines.slice(idx + 1, idx + 12)].join("\n");
    const nwin = neutralizeStrings(window);   // window[0] is the opening '('
    let d = 0;
    for (let j = 0; j < nwin.length; j++) {
      if (nwin[j] === "(") d++;
      else if (nwin[j] === ")") { d--; if (d === 0) { args = window.slice(1, j); break; } }
    }
  }
  if (args === null) return false;   // could not cleanly parse the argument -> FLAG (no false-negative)

  // Split into top-level args (null if the arg list itself doesn't parse cleanly -> flag).
  const argv = topLevelArgs(args);
  if (argv === null) return false;
  const first = (argv[0] ?? "").trimStart();

  // Safe: ARRAY literal first arg (array order is preserved).
  if (first.startsWith("[")) return true;
  // Safe: a primitive literal (string/number/boolean/template/null).
  if (/^["'`]/.test(first) || /^-?\d/.test(first) || /^(true|false|null)\b/.test(first)) return true;
  // Safe: an OBJECT LITERAL whose key order is lexically fixed — UNLESS it splices a spread `...`.
  if (first.startsWith("{") && !/\.\.\./.test(first)) return true;
  // Safe: the SERIALIZED VALUE is canonicalized — a `.sort(` in the FIRST arg, no spread. [JSF-2]
  if (/\.sort\s*\(/.test(first) && !/\.\.\./.test(first)) return true;
  // Safe: a sorted-key-array REPLACER as the 2nd arg pins output order. This is the tool's OWN
  // recommended fix shape, so it must NOT self-flag [audit FP-RECOMMENDED-FIX-SELF-FLAG]. Accept a
  // literal `[...]` replacer or a sorted key array (`Object.keys/entries(...).sort()` / `[...].sort()`).
  // Only the 2nd positional arg counts — a sort in the 3rd (space) arg does NOT pin order.
  const arg2 = (argv[1] ?? "").trim();
  if (arg2.startsWith("[")) return true;
  if (/\.sort\s*\(/.test(arg2) && /(Object\.(keys|entries)\s*\(|^\[)/.test(arg2)) return true;
  // Otherwise: order isn't provably consensused -> FLAG (low) rather than risk a silent miss.
  return false;
}

// Blank string / template / REGEX literal CONTENTS (keep length/structure) so a `(`/`)`/`[`/`]` inside
// a literal is not miscounted when balancing. Regex disambiguation: a `/` starts a regex only in a
// "non-value" position (after an operator / `(` / `,` / `=` / `:` / `[` / `{` / `;` / `return` etc.),
// otherwise it's division. Conservative + fail-safe: if we ever mis-classify, the worst case is an
// unbalanced parse, which the caller treats as "cannot prove" -> FLAG (never a false-negative).
function neutralizeStrings(s: string): string {
  let out = "", q: string | null = null, inRegex = false, prevSig = "";
  for (let k = 0; k < s.length; k++) {
    const c = s[k];
    if (q) {                                   // inside a string/template literal
      if (c === "\\") { out += "  "; k++; continue; }
      out += c === q ? c : " ";
      if (c === q) q = null;
    } else if (inRegex) {                       // inside a /regex/ literal
      if (c === "\\") { out += "  "; k++; continue; }
      out += c === "/" ? c : " ";
      if (c === "/") inRegex = false;
    } else if (c === '"' || c === "'" || c === "`") { q = c; out += c; prevSig = c; }
    else if (c === "/" && s[k + 1] !== "/" && s[k + 1] !== "*" && isRegexStart(prevSig)) {
      inRegex = true; out += c;                 // open a regex literal
    } else { out += c; if (c.trim()) prevSig = c; }
  }
  return out;
}

// Is a `/` at a position preceded by `prev` (last significant char) the start of a regex literal
// (vs a division operator)? Regex follows an operator/opening-bracket/comma/start — NOT an
// identifier char, number, `)`, or `]` (those are values that `/` would divide).
function isRegexStart(prev: string): boolean {
  if (prev === "") return true;                 // start of segment
  return !/[A-Za-z0-9_$)\]]/.test(prev);
}

// ---- "code view": blank inert LITERAL TEXT so the rules only ever match real, executed code ------
// FALSE-POSITIVE FIX (the linter's trust problem): the per-line rules previously matched against the
// comment-stripped line with string/regex CONTENTS still intact, so a determinism token that appears
// only as inert text — an error message ("do not call Math.random()"), a log line, a help string, a
// doc string, or the source of a regex literal (`/Date\.now/`) — was flagged as if it were a real
// clock/rng/network read. That text is NEVER EXECUTED, so flagging it is a pure false positive.
//
// `codeView` returns the line with the CONTENTS of single/double-quoted strings, regex literals, and
// the TEXT parts of template literals replaced by spaces (length- and column-preserving), while
// PRESERVING the executable `${ ... }` interpolations inside template literals. This is SOUND w.r.t.
// the tool's cardinal rule (never a false-negative): it only ever removes characters that the JS
// engine treats as data, never characters it executes. A real `${Date.now()}`, or any token sitting
// in actual code before/after a string, is untouched and still flagged. Template interpolations can
// nest arbitrarily (strings inside `${}` inside templates inside `${}`...), so we track a context
// stack rather than a single flag. Anything ambiguous (an unterminated literal at EOL, a `/` we can't
// classify) fails toward KEEPING the text as code — i.e. toward FLAGGING — never toward hiding it.
//
// NOTE: the `network-io` IMPORT form (`require('net')` / `from 'dns'`) legitimately reads a module
// specifier that lives INSIDE a string — neutralizing it would be a false-negative. That rule alone
// is marked `raw` and runs against the un-neutralized (comment-stripped) line; every other rule runs
// against the codeView.
type CvCtx = { kind: "code" | "sq" | "dq" | "tpl" | "regex"; brace?: number };
function codeView(line: string): string {
  let out = "";
  const stack: CvCtx[] = [{ kind: "code" }];
  let prevSig = "";
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    const top = stack[stack.length - 1];
    if (top.kind === "sq" || top.kind === "dq") {           // inside '...' or "..."
      if (c === "\\") { out += "  "; i++; continue; }       // skip escaped char (keep length)
      const q = top.kind === "sq" ? "'" : '"';
      if (c === q) { out += c; stack.pop(); prevSig = c; } else out += " ";
    } else if (top.kind === "regex") {                       // inside /.../
      if (c === "\\") { out += "  "; i++; continue; }
      if (c === "/") { out += c; stack.pop(); prevSig = c; } else out += " ";
    } else if (top.kind === "tpl") {                         // inside `...` TEXT (not interpolation)
      if (c === "\\") { out += "  "; i++; continue; }
      if (c === "`") { out += c; stack.pop(); prevSig = c; }
      else if (c === "$" && line[i + 1] === "{") {           // open an executable ${ ... }
        out += "${"; stack.push({ kind: "code", brace: 0 }); i++; prevSig = "{";
      } else out += " ";
    } else {                                                 // executable code (top.kind === "code")
      if (c === "'") { out += c; stack.push({ kind: "sq" }); prevSig = c; }
      else if (c === '"') { out += c; stack.push({ kind: "dq" }); prevSig = c; }
      else if (c === "`") { out += c; stack.push({ kind: "tpl" }); prevSig = c; }
      else if (c === "/" && line[i + 1] !== "/" && line[i + 1] !== "*" && isRegexStart(prevSig)) {
        out += c; stack.push({ kind: "regex" }); prevSig = c;
      } else if (top.brace !== undefined && c === "}" && top.brace === 0) {
        out += c; stack.pop(); prevSig = c;                  // close the ${ ... } -> back to template
      } else {
        if (top.brace !== undefined) {                       // track {} nesting within an interpolation
          if (c === "{") top.brace++;
          else if (c === "}") top.brace--;
        }
        out += c;
        if (c.trim()) prevSig = c;
      }
    }
  }
  return out;
}

// Split a call's argument string into TOP-LEVEL args (commas at paren/bracket/brace depth 0), over
// neutralized text. Returns null if the bracketing is unbalanced (depth ever negative, or != 0 at
// end) — the caller treats null as "cannot prove" and FLAGS. [closes the FN-REGEX-FIRSTARG leak]
function topLevelArgs(args: string): string[] | null {
  const n = neutralizeStrings(args);
  const out: string[] = [];
  let depth = 0, start = 0;
  for (let k = 0; k < n.length; k++) {
    const c = n[k];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") { depth--; if (depth < 0) return null; }
    else if (c === "," && depth === 0) { out.push(args.slice(start, k)); start = k + 1; }
  }
  if (depth !== 0) return null;
  out.push(args.slice(start));
  return out;
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
  // network-io CALL form (`fetch(`, `axios(`, ...). Runs against the codeView so a network verb that
  // appears only as text inside a string/log/error message is NOT a false positive.
  { id: "network-io", re: /\b(fetch|axios|got|node-fetch)\s*\(/,
    severity: "high",
    why: "Outbound network calls return different results/timing per node (and may fail on some) — non-deterministic and side-effectful inside consensus.",
    fix: "Do NOT call the network from contract logic. Bring external data in as a consensused USER INPUT, or via an oracle pattern where nodes agree on the value through NPL before acting. (If this file is your HTTP/wrapper surface OUTSIDE the consensus kernel — a createServer/http import for the operator API — this is expected; scope the scan to the deterministic kernel, not the wrapper.)" },
  // network-io IMPORT form (`require('net')` / `import ... from 'dns'`). The signal is a module
  // specifier that lives INSIDE a string literal, so this rule is `raw` (matches the un-neutralized
  // line) — neutralizing the specifier would silently miss a real network import (a false-negative).
  { id: "network-io", raw: true,
    re: /require\(['"](https?|node:https?|net|dns|node:net|node:dns)['"]\)|from\s+['"](https?|node:https?|net|dns)['"]/,
    severity: "high",
    why: "Importing a network module (http/https/net/dns) brings non-deterministic, side-effectful I/O into the contract — outbound calls return different results/timing per node (and may fail on some).",
    fix: "Do NOT import the network from contract logic. Bring external data in as a consensused USER INPUT, or via an oracle pattern where nodes agree on the value through NPL before acting. (If this file is your HTTP/wrapper surface OUTSIDE the consensus kernel — operator API — this is expected; scope the scan to the deterministic kernel, not the wrapper.)" },
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
    fix: "Keep contract behavior independent of the host environment. Pass any needed config in via the consensused contract state or inputs, not process/os. (If this file is wrapper/runtime config OUTSIDE the consensus kernel — path setup, operator tooling — `process.env`/`process.cwd()` are fine there; scope the scan to the deterministic kernel.)" },
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
    suppress: (line, m, lines, idx) => jsonStringifyIsSafe(line, m, lines, idx) },
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
  // First strip comments once (so both passes agree on what's real code). Then build the codeView
  // (string/regex/template-text contents blanked, `${}` interpolations kept) used for matching the
  // CODE-token rules. Learn Map/Set aliases from the codeView so a `new Map()` that only appears in a
  // string is not treated as a real binding (a false positive). The raw (string-intact) line is kept
  // for the one `raw` rule (network import specifiers).
  const stripped = lines.map(stripLineComment);
  const cv = stripped.map(codeView);
  const aliases = collectMapSetAliases(cv);
  lines.forEach((raw, idx) => {
    const line = cv[idx];
    for (const rule of RULES) {
      const target = rule.raw ? stripped[idx] : line;
      const m = rule.re.exec(target);
      if (m) {
        if (rule.suppress && rule.suppress(target, m, cv, idx)) continue;
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
