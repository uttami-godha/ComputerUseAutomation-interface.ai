// Error taxonomy. Replay must never "blindly proceed" — after every navigation/action it
// classifies the observed state against the artifact's declared outcome rules into one of:
//
//   business    a legitimate result the caller needs (e.g. NO_SUCH_MEMBER) — return it, not a crash
//   recoverable a known transient/interstitial condition — dismiss/wait/retry, then continue
//   hard        anything we can't safely proceed through — stop with a debuggable failure
//
// Rules are data (declared on the artifact), so the taxonomy is reviewable and extensible
// without code changes. Step-scoped rules take precedence over global ones.

import type { OutcomeRule } from "./schema.ts";

export type OutcomeMatch = {
  rule: OutcomeRule;
  matchedText: string;
};

export function matchOutcome(
  visibleText: string,
  rulesets: (OutcomeRule[] | undefined)[],
): OutcomeMatch | null {
  for (const rules of rulesets) {
    if (!rules) continue;

    for (const rule of rules) {
      let re: RegExp;

      try {
        re = new RegExp(rule.whenTextMatches, "i");
      } catch {
        continue;
      }

      const m = visibleText.match(re);
      if (m) {
        return {
          rule,
          matchedText: m[0],
        };
      }
    }
  }

  return null;
}