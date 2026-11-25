import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import nspell from "nspell";
import { words, isCorrect } from "../src/ui/spell";

test("spell: finds misspellings, skips codes, acronyms and URLs", () => {
  const sp = nspell(readFileSync("node_modules/dictionary-en/index.aff", "utf8"), readFileSync("node_modules/dictionary-en/index.dic", "utf8"));
  const text = "Pleese revise the HVAC duct at grid B-4 per RFI 12; see www.exmaple.com and the contractor's 3rd submital. Use W12x26 beams.";
  const bad = [...words(text)].filter((w) => !isCorrect(sp, w.word)).map((w) => w.word);
  assert.deepEqual(bad, ["Pleese", "submital"]);
  assert.ok(sp.suggest("submital").includes("submittal") || sp.suggest("submital").length > 0);
  const w = [...words("say hello")];
  assert.equal(w[1].start, 4);
});
