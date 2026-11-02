import { REDIS_CODE_PATTERN } from "./logger.js";
import { MAX_CODES_PER_LINE, MAX_TRACKED_CODES } from "./worker-constants.js";

// The Redis error counter (Task 012B-3; B2-6 as the founder amended it;
// PD-9; S-5; Gate E's error part). The queue and probe connections' `error`
// listeners only count per classified code, inside or outside a cycle; the
// counts are taken only by the cycle line, so errors arriving between cycles
// cannot bypass the per-line limit. Nothing is written here.

export interface ErrorCounts {
  readonly errors: readonly { readonly code: string; readonly count: number }[];
  readonly errorsOther: number;
}

export interface ErrorCounter {
  /** Counts one occurrence; a code not matching the Redis pattern counts as UNCLASSIFIED. */
  count(code: string): void;
  /** At most MAX_CODES_PER_LINE codes (count descending, then code ascending), the rest in errorsOther; then resets. */
  takeCounts(): ErrorCounts;
}

export function createErrorCounter(): ErrorCounter {
  const counts = new Map<string, number>();
  let overflow = 0;
  return Object.freeze({
    count: (code: string): void => {
      const normalized = typeof code === "string" && REDIS_CODE_PATTERN.test(code) ? code : "UNCLASSIFIED";
      const current = counts.get(normalized);
      if (current !== undefined) counts.set(normalized, current + 1);
      else if (counts.size < MAX_TRACKED_CODES) counts.set(normalized, 1);
      else overflow++;
    },
    takeCounts: (): ErrorCounts => {
      const sorted = [...counts.entries()].sort(([codeA, countA], [codeB, countB]) =>
        countA !== countB ? countB - countA : codeA < codeB ? -1 : codeA > codeB ? 1 : 0,
      );
      const listed = sorted.slice(0, MAX_CODES_PER_LINE).map(([code, count]) => Object.freeze({ code, count }));
      const errorsOther = sorted.slice(MAX_CODES_PER_LINE).reduce((sum, [, count]) => sum + count, overflow);
      counts.clear();
      overflow = 0;
      return Object.freeze({ errors: Object.freeze(listed), errorsOther });
    },
  });
}
