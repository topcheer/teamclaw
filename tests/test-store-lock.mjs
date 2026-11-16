import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { withStoreLock } from "../src/dist/src/teamauto/store.js";

const schedulerSource = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "src", "src", "teamauto", "scheduler.ts"), "utf8");

test("#5712: withStoreLock serializes concurrent RMW sections (no interleaved clobber)", async () => {
  const box = { value: 0, log: [] };
  const workers = Array.from({ length: 8 }, (_, i) =>
    withStoreLock(async () => {
      const before = box.value;          // read
      await new Promise((r) => setTimeout(r, Math.random() * 5));
      box.value = before + 1;            // modify (would clobber if interleaved)
      box.log.push(`${i}:${before}->${before + 1}`);
    }),
  );
  await Promise.all(workers);
  assert.equal(box.value, 8, "every locked section must land - a lost update means the lock stopped serializing");
  assert.equal(box.log.length, 8);
});

// ---------- structural coverage checker (no regex: backslash-stable) ----------

const NL = String.fromCharCode(10);
const BS = String.fromCharCode(92);

/** Mask strings and comments (length-preserving, spaces) so bracket matching
 * operates on code structure only. Template literals are masked to their
 * closing backtick - ${...} interpolation bodies are treated as string,
 * which is the conservative direction for this checker (a save inside an
 * interpolation would be over-masked and flag as uncovered, never missed). */
function maskStringsAndComments(src) {
  const out = src.split("");
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== NL) { out[i] = " "; i += 1; }
    } else if (c === "/" && src[i + 1] === "*") {
      out[i] = " "; out[i + 1] = " "; i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) { out[i] = " "; i += 1; }
      if (i < src.length) { out[i] = " "; out[i + 1] = " "; i += 2; }
    } else if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      out[i] = " "; i += 1;
      while (i < src.length && src[i] !== quote) {
        if (src[i] === BS) { out[i] = " "; i += 1; if (i < src.length) { out[i] = " "; } }
        i += 1;
      }
      if (i < src.length) { out[i] = " "; }
      i += 1;
    } else {
      i += 1;
    }
  }
  return out.join("");
}

const masked = maskStringsAndComments(schedulerSource);

function isWordChar(ch) {
  return /[A-Za-z0-9_]/.test(ch);
}

/** All call sites of identifier `name` on the masked source: positions where
 * `name` is a standalone word immediately followed (after spaces) by "(". */
function identifierCallPositions(text, name) {
  const positions = [];
  let from = 0;
  for (;;) {
    const at = text.indexOf(name, from);
    if (at < 0) { break; }
    from = at + name.length;
    const prev = at > 0 ? text[at - 1] : " ";
    if (isWordChar(prev)) { continue; }
    let j = at + name.length;
    while (j < text.length && text[j] === " ") { j += 1; }
    if (text[j] !== "(") { continue; }
    positions.push({ ident: at, paren: j });
  }
  return positions;
}

/** Match the bracket starting at `open` and return [open, closeIndex]. */
function matchBracket(text, open) {
  const kind = text[open] === "(" ? ["(", ")"] : ["{", "}"];
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === kind[0]) { depth += 1; }
    if (text[i] === kind[1]) {
      depth -= 1;
      if (depth === 0) { return [open, i]; }
    }
  }
  throw new Error("unbalanced brackets after " + open);
}

function inside(pos, range) {
  return pos >= range[0] && pos <= range[1];
}

function lineOf(pos) {
  let line = 1;
  for (let i = 0; i < pos && i < schedulerSource.length; i += 1) {
    if (schedulerSource[i] === NL) { line += 1; }
  }
  return line;
}

test("#5712: every saveTeamAutoStore call site in scheduler.ts is lock-covered", () => {
  const lockRanges = identifierCallPositions(masked, "withStoreLock").map((c) => matchBracket(masked, c.paren));
  assert.ok(lockRanges.length >= 10, "expected the sweep/reconcile/claim/config lock sections to exist, found " + lockRanges.length);
  // Two locked-core functions save without their own withStoreLock wrapper
  // BY DESIGN: they only ever run inside a caller-withheld lock section.
  // - registerWritebackUnlocked: called from the sweep transaction and the
  //   locked registerWriteback wrapper (the promise-chain mutex is NOT
  //   re-entrant, so the cores cannot take the lock themselves).
  // - doReconcileWritebacksLocked: called from exactly one site inside
  //   doReconcileWritebacks' withStoreLock section.
  const coreBodies = ["registerWritebackUnlocked", "doReconcileWritebacksLocked"].map((name) => {
    const defs = identifierCallPositions(masked, name).filter((c) => {
      const before = masked.slice(Math.max(0, c.ident - 20), c.ident);
      return before.includes("function ");
    });
    assert.equal(defs.length, 1, "exactly one " + name + " definition expected");
    const bodyOpen = masked.indexOf("{", defs[0].paren);
    return { name, body: matchBracket(masked, bodyOpen), defs };
  });
  const coreBody = coreBodies[0].body;
  const saves = identifierCallPositions(masked, "saveTeamAutoStore");
  assert.ok(saves.length >= 10, "expected the known save sites, found " + saves.length);
  const uncovered = saves.filter((m) => {
    const covered = lockRanges.some((r) => inside(m.ident, r)) || coreBodies.some((c) => inside(m.ident, c.body));
    return !covered;
  });
  assert.deepEqual(uncovered.map((m) => lineOf(m.ident)), [],
    "saveTeamAutoStore call sites outside withStoreLock at these source lines - #5712 requires ALL store writes lock-covered");
  // And each core must only ever be CALLED from inside a lock section.
  for (const core of coreBodies) {
    const calls = identifierCallPositions(masked, core.name).filter((c) => !core.defs.some((d) => d.ident === c.ident));
    assert.ok(calls.length >= 1, "expected at least one " + core.name + " call site");
    for (const c of calls) {
      assert.ok(lockRanges.some((r) => inside(c.ident, r)), core.name + " called outside a lock section at line " + lineOf(c.ident));
    }
  }
});

test("#5712: no activity row rides the bare closure cache to its death", () => {
  // Bare recordActivity(await ensureStore(), ...) rows are dropped whenever
  // a locked pass replaces the cache with its disk reload - the exact way the
  // 20:30 batch lost its sweep/task lines. They must route through
  // recordActivityPersisted (or live inside a locked section on a fresh snapshot).
  assert.equal(masked.indexOf("recordActivity(await ensureStore("), -1,
    "found a bare recordActivity(await ensureStore(), ...) - convert it to recordActivityPersisted");
  assert.ok(schedulerSource.includes("recordActivityPersisted"), "persisted-activity helper must exist");
});

test("#5712: sweep self-audit + locked-snapshot refresh anchors", () => {
  // The sweep transaction must re-read the store under the lock (its snapshot
  // predates the candidate fetch) and read the commit back after saving (the
  // issue per-sweep reconciliation ask, automated).
  assert.ok(schedulerSource.includes("#5712 residual"), "snapshot-refresh rationale comment must exist");
  assert.ok(schedulerSource.includes("store = await loadTeamAutoStore();" + NL + "      s = store;"), "sweep locked section must refresh and rebind the snapshot");
  assert.ok(schedulerSource.includes("#5712 ask 3"), "self-audit rationale comment must exist");
  assert.ok(schedulerSource.includes("const audit = await loadTeamAutoStore();"), "post-commit read-back must exist");
  assert.ok(schedulerSource.includes("self-audit mismatch (budget ok=${budgetOk}, activity ok=${activityOk}): re-applied sweep commit"), "alarm activity line must stay greppable");
});
