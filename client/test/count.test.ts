import assert from "node:assert/strict";
import { test } from "node:test";
import { countCharacters } from "../src/count.ts";

test("counts characters without line breaks", () => {
  assert.equal(countCharacters(""), 0);
  assert.equal(countCharacters("abc\nあいう\n"), 6);
  assert.equal(countCharacters("a b　c"), 5);
});

test("counts what appears as one character as one", () => {
  assert.equal(countCharacters("👍🏽"), 1);
  assert.equal(countCharacters("👨‍👩‍👧"), 1);
  assert.equal(countCharacters("é"), 1);
  assert.equal(countCharacters("a\r\nb"), 2);
});
