import { test } from "node:test";
import assert from "node:assert/strict";
import { withStoreLock } from "../src/dist/src/teamauto/store.js";

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
  assert.equal(box.value, 8, "every increment must land - a lost update means the lock failed");
});
