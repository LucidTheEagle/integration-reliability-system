import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createErrorCounter } from "./error-counter.js";

// Task 012B-3 (B2-6 as the founder amended it; PD-9; S-5; Gate E's error
// part): errors are counted per code between cycle lines and taken only by
// the cycle line, so a burst cannot become an unbounded stream of lines.

describe("error counter: per-code counting (B2-6)", () => {
  it("a burst of 1,000 errors over 3 codes between two cycle lines gives one entry per code, with exact counts", () => {
    const counter = createErrorCounter();
    for (let n = 0; n < 1000; n++) counter.count(["ECONNREFUSED", "ETIMEDOUT", "COMMAND_TIMEOUT"][n % 3] ?? "");
    const taken = counter.takeCounts();
    assert.deepEqual(taken.errors, [
      { code: "ECONNREFUSED", count: 334 },
      { code: "COMMAND_TIMEOUT", count: 333 },
      { code: "ETIMEDOUT", count: 333 },
    ]);
    assert.equal(taken.errorsOther, 0);
  });

  it("12 codes give 8 entries (count descending, then code ascending) and the rest in errorsOther (PD-9)", () => {
    const counter = createErrorCounter();
    for (let c = 0; c < 12; c++) {
      for (let n = 0; n <= c; n++) counter.count(`CODE_${String(c).padStart(2, "0")}`);
    }
    counter.count("TIE_B");
    counter.count("TIE_A");
    const taken = counter.takeCounts();
    assert.equal(taken.errors.length, 8);
    assert.deepEqual(
      taken.errors.map((entry) => entry.code),
      ["CODE_11", "CODE_10", "CODE_09", "CODE_08", "CODE_07", "CODE_06", "CODE_05", "CODE_04"],
    );
    // Not listed: CODE_03 (4) + CODE_02 (3) + CODE_01 (2) + CODE_00 (1) + TIE_A (1) + TIE_B (1).
    assert.equal(taken.errorsOther, 12);
  });

  it("ties are listed in code order", () => {
    const counter = createErrorCounter();
    for (const code of ["E_C", "E_A", "E_B"]) counter.count(code);
    assert.deepEqual(counter.takeCounts().errors.map((entry) => entry.code), ["E_A", "E_B", "E_C"]);
  });

  it("70 distinct codes exercise the overflow: 64 tracked, every further new code counted in errorsOther (S-5)", () => {
    const counter = createErrorCounter();
    for (let c = 0; c < 70; c++) counter.count(`CODE_${c}`);
    counter.count("CODE_0");
    const taken = counter.takeCounts();
    assert.equal(taken.errors.length, 8);
    assert.deepEqual(taken.errors[0], { code: "CODE_0", count: 2 });
    // 71 occurrences: 9 listed (CODE_0 twice, 7 others once), 56 tracked but unlisted, 6 overflow.
    assert.equal(taken.errorsOther, 71 - 9);
  });

  it("a planted lower-case or over-long code is counted as UNCLASSIFIED", () => {
    const counter = createErrorCounter();
    counter.count("planted-marker-7f3a");
    counter.count(`E${"X".repeat(48)}`);
    counter.count("");
    assert.deepEqual(counter.takeCounts().errors, [{ code: "UNCLASSIFIED", count: 3 }]);
  });

  it("resets after a take; counts accumulate whether or not a cycle is running", () => {
    const counter = createErrorCounter();
    counter.count("ECONNREFUSED");
    assert.equal(counter.takeCounts().errors.length, 1);
    assert.deepEqual(counter.takeCounts(), { errors: [], errorsOther: 0 });
    counter.count("ECONNREFUSED");
    counter.count("ECONNREFUSED");
    assert.deepEqual(counter.takeCounts().errors, [{ code: "ECONNREFUSED", count: 2 }]);
  });
});
