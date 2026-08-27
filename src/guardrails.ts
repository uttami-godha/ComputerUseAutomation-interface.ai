import type {
  RiskClass,
  Step,
} from "./artifact/schema.ts";
import type {
  Policy,
} from "./config.ts";

export type GuardrailDecision =
  | {
      allowed: true;
      risk: RiskClass;
      handling: "allow";
    }
  | {
      allowed: false;
      risk: RiskClass;
      handling:
        | "require_approval"
        | "require_confirmation";
      reason: string;
    };

export function classifyRisk(
  step: Step,
  policy: Policy,
): RiskClass {
  const intent =
    normalize(step.intent ?? "");

  const description =
    normalize(
      step.target?.description ?? "",
    );

  const combined =
    `${intent} ${description}`;

  if (
    policy.risk.irreversibleIntents
      .some((x) =>
        combined.includes(
          normalize(x),
        ),
      )
  ) {
    return "irreversible";
  }

  if (
    policy.risk.riskyIntents
      .some((x) =>
        combined.includes(
          normalize(x),
        ),
      )
  ) {
    return "risky";
  }

  if (
    policy.risk.riskyControlText
      .some((x) =>
        combined.includes(
          normalize(x),
        ),
      )
  ) {
    return "risky";
  }

  // A recorded risk classification may make a step
  // stricter, but inference must never downgrade it.
  if (
    step.risk === "irreversible"
  ) {
    return "irreversible";
  }

  if (step.risk === "risky") {
    return "risky";
  }

  return "safe";
}

export function checkGuardrails(
  step: Step,
  policy: Policy,
): GuardrailDecision {
  if (
    !policy.allowlist.actionTypes
      .includes(step.action.type)
  ) {
    return {
      allowed: false,
      risk: "irreversible",
      handling:
        "require_confirmation",
      reason:
        `action type not allowed: ${step.action.type}`,
    };
  }

  const risk =
    classifyRisk(step, policy);

  const handling =
    policy.handling[risk];

  if (handling === "allow") {
    return {
      allowed: true,
      risk,
      handling,
    };
  }

  return {
    allowed: false,
    risk,
    handling,
    reason:
      `${risk} action requires ${
        handling ===
        "require_confirmation"
          ? "confirmation"
          : "approval"
      }`,
  };
}

export function assertUrlAllowed(
  value: string,
  policy: Policy,
): void {
  let url: URL;

  try {
    url = new URL(value);
  } catch {
    throw new Error(
      `invalid URL: ${value}`,
    );
  }

  if (
    !policy.allowlist.origins
      .includes(url.origin)
  ) {
    throw new Error(
      `navigation blocked by policy: origin ${url.origin} is not allowlisted`,
    );
  }

  if (
    !policy.allowlist.pathPrefixes
      .some((prefix) =>
        url.pathname.startsWith(
          prefix,
        ),
      )
  ) {
    throw new Error(
      `navigation blocked by policy: path ${url.pathname} is not allowlisted`,
    );
  }
}

function normalize(
  value: string,
): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}