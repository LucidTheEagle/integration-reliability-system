import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventState } from "./index.js";
import {
  assertEventStateTransition,
  canTransitionEventState,
  IllegalEventStateTransitionError,
} from "./index.js";

/**
 * Independently restated from the Master Specification's §6.1 diagram
 * (Task 007's own "CANONICAL EVENT STATE MODEL" section) — NOT derived
 * from event-state-machine.ts's own EVENT_STATE_TRANSITIONS table. If
 * this list were built from the implementation's own data, every test
 * below would just prove the implementation agrees with itself; written
 * independently, it actually proves the implementation matches the spec.
 */
const LEGAL_TRANSITIONS: ReadonlyArray<readonly [EventState, EventState]> = [
  [EventState.RECEIVED, EventState.VALIDATED],
  [EventState.RECEIVED, EventState.REJECTED],
  [EventState.RECEIVED, EventState.DUPLICATE],
  [EventState.VALIDATED, EventState.QUEUED],
  [EventState.QUEUED, EventState.PROCESSING],
  [EventState.PROCESSING, EventState.SUCCEEDED],
  [EventState.PROCESSING, EventState.RETRYING],
  [EventState.PROCESSING, EventState.FAILED],
  [EventState.PROCESSING, EventState.UNKNOWN],
  [EventState.RETRYING, EventState.PROCESSING],
];

const ALL_STATES: readonly EventState[] = Object.values(EventState);

const TERMINAL_STATES: readonly EventState[] = [
  EventState.SUCCEEDED,
  EventState.FAILED,
  EventState.UNKNOWN,
  EventState.REJECTED,
  EventState.DUPLICATE,
];

function isLegal(from: EventState, to: EventState): boolean {
  return LEGAL_TRANSITIONS.some(([f, t]) => f === from && t === to);
}

// ---------------------------------------------------------------------
// Legal transitions, named explicitly — directly traceable to the ten
// arrows in the Master Specification's diagram, one test per arrow.
// ---------------------------------------------------------------------
describe("canTransitionEventState — legal transitions", () => {
  for (const [from, to] of LEGAL_TRANSITIONS) {
    it(`${from} -> ${to} is legal`, () => {
      assert.equal(canTransitionEventState(from, to), true);
    });
  }
});

describe("assertEventStateTransition — legal transitions do not throw", () => {
  for (const [from, to] of LEGAL_TRANSITIONS) {
    it(`${from} -> ${to} does not throw`, () => {
      assert.doesNotThrow(() => assertEventStateTransition(from, to));
    });
  }
});

// ---------------------------------------------------------------------
// Illegal transitions, named explicitly per the categories Task 007
// calls out by name. Redundant with the exhaustive matrix below, but
// kept as its own readable, directly-labeled section per the task's
// explicit request to "explicitly prove" these specific cases.
// ---------------------------------------------------------------------
describe("canTransitionEventState — specifically called-out illegal transitions", () => {
  const namedIllegal: ReadonlyArray<readonly [string, EventState, EventState]> = [
    ["RECEIVED -> PROCESSING directly", EventState.RECEIVED, EventState.PROCESSING],
    ["RECEIVED -> SUCCEEDED directly", EventState.RECEIVED, EventState.SUCCEEDED],
    ["RECEIVED -> FAILED directly", EventState.RECEIVED, EventState.FAILED],
    ["PROCESSING -> QUEUED", EventState.PROCESSING, EventState.QUEUED],
    ["PROCESSING -> VALIDATED", EventState.PROCESSING, EventState.VALIDATED],
    ["RETRYING -> SUCCEEDED", EventState.RETRYING, EventState.SUCCEEDED],
    ["RETRYING -> FAILED", EventState.RETRYING, EventState.FAILED],
  ];

  for (const [label, from, to] of namedIllegal) {
    it(label, () => {
      assert.equal(canTransitionEventState(from, to), false);
    });
  }

  it("VALIDATED -> anything except QUEUED is illegal", () => {
    for (const to of ALL_STATES) {
      if (to === EventState.QUEUED) continue;
      assert.equal(
        canTransitionEventState(EventState.VALIDATED, to),
        false,
        `VALIDATED -> ${to} should be illegal`,
      );
    }
  });

  it("QUEUED -> anything except PROCESSING is illegal", () => {
    for (const to of ALL_STATES) {
      if (to === EventState.PROCESSING) continue;
      assert.equal(
        canTransitionEventState(EventState.QUEUED, to),
        false,
        `QUEUED -> ${to} should be illegal`,
      );
    }
  });
});

describe("assertEventStateTransition — illegal transitions always throw IllegalEventStateTransitionError", () => {
  it("throws with the attempted from/to attached to the error", () => {
    assert.throws(
      () => assertEventStateTransition(EventState.RECEIVED, EventState.SUCCEEDED),
      (error: unknown) => {
        assert.ok(error instanceof IllegalEventStateTransitionError);
        assert.equal((error as IllegalEventStateTransitionError).from, EventState.RECEIVED);
        assert.equal((error as IllegalEventStateTransitionError).to, EventState.SUCCEEDED);
        return true;
      },
    );
  });
});

// ---------------------------------------------------------------------
// Acceptance-criteria-shaped invariants, tested directly rather than
// only implicitly via the full matrix below.
// ---------------------------------------------------------------------
describe("terminal states cannot transition anywhere (acceptance criterion 3)", () => {
  for (const from of TERMINAL_STATES) {
    it(`${from} has zero legal destinations, including itself`, () => {
      for (const to of ALL_STATES) {
        assert.equal(
          canTransitionEventState(from, to),
          false,
          `${from} -> ${to} should be illegal (terminal state)`,
        );
      }
    });
  }
});

describe("RETRYING can return only to PROCESSING (acceptance criterion 4)", () => {
  it("RETRYING -> PROCESSING is the only legal destination from RETRYING", () => {
    for (const to of ALL_STATES) {
      const expected = to === EventState.PROCESSING;
      assert.equal(
        canTransitionEventState(EventState.RETRYING, to),
        expected,
        `RETRYING -> ${to} expected ${expected}`,
      );
    }
  });
});

// ---------------------------------------------------------------------
// Same-state transitions — explicit decision, per Task 007's own
// instruction not to silently allow these. DECISION: the Master
// Specification's diagram contains no self-loop arrows anywhere, so
// every same-state pair (RECEIVED -> RECEIVED, PROCESSING -> PROCESSING,
// etc.) is treated as illegal, consistent with every other transition
// not explicitly drawn. Flagging this in the implementation summary as
// an interpretation, not a silent spec change, per the task's own
// instruction to do so if there's any doubt.
// ---------------------------------------------------------------------
describe("same-state transitions are illegal (explicit decision, not a spec change)", () => {
  for (const state of ALL_STATES) {
    it(`${state} -> ${state} is illegal`, () => {
      assert.equal(canTransitionEventState(state, state), false);
    });
  }
});

// ---------------------------------------------------------------------
// Exhaustive backstop: every one of the 100 possible (from, to) pairs
// among EventState's ten values, checked against the independently
// authored LEGAL_TRANSITIONS list above. This is what actually
// guarantees nothing in the 90 illegal pairs was missed by the named
// sections above, rather than trusting that the named categories
// happen to add up to full coverage.
// ---------------------------------------------------------------------
describe("canTransitionEventState — full 10x10 matrix (exhaustive)", () => {
  for (const from of ALL_STATES) {
    for (const to of ALL_STATES) {
      const expected = isLegal(from, to);
      it(`${from} -> ${to} is ${expected ? "legal" : "illegal"}`, () => {
        assert.equal(canTransitionEventState(from, to), expected);
      });
    }
  }
});

describe("assertEventStateTransition — full 10x10 matrix (exhaustive)", () => {
  for (const from of ALL_STATES) {
    for (const to of ALL_STATES) {
      const expected = isLegal(from, to);
      it(`${from} -> ${to} ${expected ? "does not throw" : "throws"}`, () => {
        if (expected) {
          assert.doesNotThrow(() => assertEventStateTransition(from, to));
        } else {
          assert.throws(
            () => assertEventStateTransition(from, to),
            IllegalEventStateTransitionError,
          );
        }
      });
    }
  }
});

describe("EVENT_STATE_TRANSITIONS table integrity", () => {
  it("has exactly ten entries in the legal-transition list, matching the spec's ten arrows", () => {
    assert.equal(LEGAL_TRANSITIONS.length, 10);
  });

  it("the sum of legal destinations across all states equals the number of legal transitions", () => {
    let total = 0;
    for (const from of ALL_STATES) {
      for (const to of ALL_STATES) {
        if (canTransitionEventState(from, to)) total += 1;
      }
    }
    assert.equal(total, LEGAL_TRANSITIONS.length);
  });
});