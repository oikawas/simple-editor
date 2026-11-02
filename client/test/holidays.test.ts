import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { japaneseHoliday } from "../src/holidays.ts";

// The same lists the core's Rust implementation is tested against.
const fixtures: Record<string, string[]> = JSON.parse(
  fs.readFileSync(new URL("../../core/tests/holidays.json", import.meta.url), "utf8"),
);

test("matches the Cabinet Office lists", () => {
  for (const [year, want] of Object.entries(fixtures)) {
    const got: string[] = [];
    for (let m = 1; m <= 12; m++) {
      for (let d = 1; d <= 31; d++) {
        const mm = String(m).padStart(2, "0");
        const dd = String(d).padStart(2, "0");
        const name = japaneseHoliday(`${year}-${mm}-${dd}`);
        if (name) got.push(`${mm}-${dd} ${name}`);
      }
    }
    assert.deepEqual(got, want, `holidays of ${year}`);
  }
});

test("rejects dates that do not exist", () => {
  assert.equal(japaneseHoliday("2026-02-30"), null);
  assert.equal(japaneseHoliday("2026-11"), null);
});
