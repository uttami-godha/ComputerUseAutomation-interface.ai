import {
  readFileSync,
} from "node:fs";

export type Policy = {
  version: number;

  allowlist: {
    origins: string[];
    pathPrefixes: string[];
    actionTypes: string[];
  };

  risk: {
    irreversibleIntents: string[];
    riskyIntents: string[];
    safeActionTypes: string[];
    riskyControlText: string[];
  };

  handling: {
    irreversible:
      | "allow"
      | "require_approval"
      | "require_confirmation";
    risky:
      | "allow"
      | "require_approval"
      | "require_confirmation";
    safe:
      | "allow"
      | "require_approval"
      | "require_confirmation";
  };

  redaction: {
    patterns: {
      name: string;
      regex: string;
    }[];
    mask: string;
  };
};

export function loadPolicy(
  path = "config/policy.json",
): Policy {
  const raw = readFileSync(
    path,
    "utf8",
  );

  const parsed =
    JSON.parse(raw) as Policy;

  if (
    !parsed ||
    typeof parsed !== "object"
  ) {
    throw new Error(
      `invalid policy: ${path}`,
    );
  }

  if (
    typeof parsed.version !== "number"
  ) {
    throw new Error(
      "policy.version must be a number",
    );
  }

  return parsed;
}

export type RuntimeConfig = {
  policy: Policy;
  anthropicApiKey?: string;
  anthropicModel: string;
};

export function loadConfig(
  policyPath?: string,
): RuntimeConfig {
  return {
    policy: loadPolicy(
      policyPath ??
        "config/policy.json",
    ),
    anthropicApiKey:
      process.env.ANTHROPIC_API_KEY,
    anthropicModel:
      process.env.ANTHROPIC_MODEL ??
      "claude-sonnet-4-5",
  };
}