import type { RiskClass } from "./artifact/schema.ts";
import type { Policy } from "./config.ts";

export type AllowDecision = {
  allowed: boolean;
  reason?: string;
};

export type HandlingDecision =
  | { verdict: "allow" }
  | { verdict: "block"; reason: string };

export type ClassifyRiskInput = {
  actionType: string;
  intent?: string;
  controlText?: string;
  // A risk class already recorded on the artifact step (from discovery, or a
  // human review). Keyword inference below can only raise the classification
  // above this floor, never silently drop back below it.
  recordedRisk?: RiskClass;
};

export type HandlingContext = {
  approved: boolean;
  allowRisky: boolean;
  confirmed: boolean;
};

function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Plain substring matching would flag "Confirmation Ref" for the "confirm"
// keyword, or "submitted" for "submit" - match whole words/phrases only.
function containsKeyword(text: string, keyword: string): boolean {
  const pattern = new RegExp(
    `\\b${escapeRegExp(normalize(keyword))}\\b`,
    "i",
  );

  return pattern.test(text);
}

// Shared by discovery (live classification of the model's next action) and
// replay (re-classification of a recorded step) so both paths gate risk
// identically. An irreversible match is never downgraded.
export class Guardrails {
  private policy: Policy;

  constructor(policy: Policy) {
    this.policy = policy;
  }

  classifyRisk(input: ClassifyRiskInput): RiskClass {
    const combined =
      `${input.intent ?? ""} ${input.controlText ?? ""}`;

    if (
      this.policy.risk.irreversibleIntents.some((x) =>
        containsKeyword(combined, x),
      ) ||
      input.recordedRisk === "irreversible"
    ) {
      return "irreversible";
    }

    if (
      this.policy.risk.riskyIntents.some((x) =>
        containsKeyword(combined, x),
      ) ||
      this.policy.risk.riskyControlText.some((x) =>
        containsKeyword(combined, x),
      ) ||
      input.recordedRisk === "risky"
    ) {
      return "risky";
    }

    return "safe";
  }

  checkActionType(actionType: string): AllowDecision {
    if (!this.policy.allowlist.actionTypes.includes(actionType)) {
      return {
        allowed: false,
        reason: `action type not allowed: ${actionType}`,
      };
    }

    return { allowed: true };
  }

  checkNavigation(url: string): AllowDecision {
    let parsed: URL;

    try {
      parsed = new URL(url);
    } catch {
      return {
        allowed: false,
        reason: `invalid URL: ${url}`,
      };
    }

    if (!this.policy.allowlist.origins.includes(parsed.origin)) {
      return {
        allowed: false,
        reason: `origin not allowlisted: ${parsed.origin}`,
      };
    }

    if (
      !this.policy.allowlist.pathPrefixes.some((prefix) =>
        parsed.pathname.startsWith(prefix),
      )
    ) {
      return {
        allowed: false,
        reason: `path not allowlisted: ${parsed.pathname}`,
      };
    }

    return { allowed: true };
  }

  decideHandling(
    risk: RiskClass,
    ctx: HandlingContext,
  ): HandlingDecision {
    const handling = this.policy.handling[risk];

    if (handling === "allow") {
      return { verdict: "allow" };
    }

    if (risk === "irreversible") {
      if (ctx.confirmed) return { verdict: "allow" };

      return {
        verdict: "block",
        reason: "irreversible action requires explicit confirmation",
      };
    }

    // risky
    if (ctx.approved || ctx.allowRisky) {
      return { verdict: "allow" };
    }

    return {
      verdict: "block",
      reason:
        "risky action requires an approved artifact or --allow-risky",
    };
  }
}
