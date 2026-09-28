import type { EventState } from "./enums.js";

/**
 * The complete, canonical set of legal EventState transitions, taken
 * directly from the Master Specification's §6.1 diagram (Task 007).
 *
 * Every one of EventState's ten values has an entry below, even the five
 * terminal states (empty arrays) — the `Record<EventState, ...>` type
 * requires it, so TypeScript itself refuses to compile this file if a
 * state is ever added to `enums.ts` without a corresponding line being
 * added here. That is deliberate: this table is meant to be exhaustive
 * by construction, not by discipline.
 *
 * Self-transitions (e.g. RECEIVED -> RECEIVED) are deliberately absent —
 * see the module-level note in this file's test suite for why.
 *
 * Frozen (both the outer object and every inner array) so nothing can
 * mutate the canonical table at runtime.
 */
const EVENT_STATE_TRANSITIONS_MUTABLE: Record<EventState, EventState[]> = {
  RECEIVED: ["VALIDATED", "REJECTED", "DUPLICATE"],
  VALIDATED: ["QUEUED"],
  QUEUED: ["PROCESSING"],
  PROCESSING: ["SUCCEEDED", "RETRYING", "FAILED", "UNKNOWN"],
  RETRYING: ["PROCESSING"],
  SUCCEEDED: [],
  FAILED: [],
  UNKNOWN: [],
  REJECTED: [],
  DUPLICATE: [],
};

for (const destinations of Object.values(EVENT_STATE_TRANSITIONS_MUTABLE)) {
  Object.freeze(destinations);
}

export const EVENT_STATE_TRANSITIONS: Readonly<
  Record<EventState, readonly EventState[]>
> = Object.freeze(EVENT_STATE_TRANSITIONS_MUTABLE);

/**
 * Returns whether a transition from one EventState to another is legal
 * per the Master Specification. Pure, deterministic, side-effect free —
 * a plain table lookup.
 */
export function canTransitionEventState(from: EventState, to: EventState): boolean {
  return EVENT_STATE_TRANSITIONS[from].includes(to);
}

/**
 * Thrown by assertEventStateTransition when a transition is illegal.
 * Carries the attempted `from`/`to` values as structured data, not just
 * a formatted string, so callers can inspect what was attempted without
 * parsing the message.
 */
export class IllegalEventStateTransitionError extends Error {
  public readonly from: EventState;
  public readonly to: EventState;

  constructor(from: EventState, to: EventState) {
    super(`Illegal EventState transition: ${from} -> ${to}`);
    this.name = "IllegalEventStateTransitionError";
    this.from = from;
    this.to = to;
    Object.setPrototypeOf(this, IllegalEventStateTransitionError.prototype);
  }
}

/**
 * Enforces a legal EventState transition. Throws
 * IllegalEventStateTransitionError if the transition is not in the
 * canonical table — illegal transitions never silently succeed.
 */
export function assertEventStateTransition(from: EventState, to: EventState): void {
  if (!canTransitionEventState(from, to)) {
    throw new IllegalEventStateTransitionError(from, to);
  }
}