// The capability artifact — the load-bearing contract of this system.
//
// It says what a capability does, what inputs it needs, what outputs it
// produces, how to find each control, where the checkpoints are, and which
// outcomes are expected. It is deliberately decoupled from the model that
// discovered it: THIS is the capability.
//
// Design priorities, in order:
//   1. Robust targeting
//   2. Clear I/O contract
//   3. Deterministic outcomes
//   4. Reuse across tenants
//   5. Governance, escalation, evidence

import type { LocatorStrategy } from "../surface/surface.ts";

export const ARTIFACT_SCHEMA_VERSION = "2.0.0";

export type ParamType = "string" | "number" | "boolean";

export type ParamSpec = {
  name: string;
  type: ParamType;
  required: boolean;
  redact: boolean;
  description?: string;
};

export type OutputSpec = {
  name: string;
  type: ParamType;
  redact: boolean;
  fromStep: string;
  description?: string;
};

export type RiskClass = "safe" | "risky" | "irreversible";

export type ValueRef =
  | { param: string }
  | { literal: string | number | boolean };

export type StepAction =
  | {
      type: "navigate";
      url: string;
    }
  | {
      type: "click";
    }
  | {
      type: "type";
      value: ValueRef;
      secret?: boolean;
    }
  | {
      type: "select";
      value: ValueRef;
    }
  | {
      type: "press";
      key?: string;
    }
  | {
      type: "read";
    }
  | {
      type: "waitFor";
      text?: string;
      ms?: number;
    }
  | {
      type: "assert";
      text: string;
    };

export type OutcomeClassification =
  | "business"
  | "recoverable"
  | "hard";

export type OutcomeAction =
  | "return"
  | "dismiss_and_continue"
  | "wait_retry"
  | "stop";

export type OutcomeRule = {
  outcome: string;

  // Regex evaluated against the currently visible page text.
  whenTextMatches: string;

  classification: OutcomeClassification;

  action: OutcomeAction;

  recover?: {
    strategies?: LocatorStrategy[];
    maxRetries?: number;
    waitMs?: number;
  };

  message?: string;
};

export type Step = {
  id: string;
  intent?: string;

  action: StepAction;

  risk: RiskClass;

  checkpoint?: {
    text?: string;
  };

  target?: {
    description?: string;
    strategies: LocatorStrategy[];
  };

  extractAs?: string;

  // Step-scoped outcomes are evaluated before the artifact's global rules.
  outcomes?: OutcomeRule[];
};

export type ArtifactTarget = {
  surfaceKind: "web" | "legacy-web" | "desktop";
  appId: string;
  vendorProduct?: string;
  tenantId?: string;
  baseUrl: string;
  entryPath: string;
};

export type Artifact = {
  schemaVersion: typeof ARTIFACT_SCHEMA_VERSION;

  capabilityId: string;
  name: string;
  description: string;

  version: number;
  status: "draft" | "approved";
  confidence: number;

  target: ArtifactTarget;

  params: ParamSpec[];
  outputs: OutputSpec[];

  steps: Step[];

  globalOutcomes?: OutcomeRule[];

  successCondition?: {
    text?: string;
    allOutputsPresent?: boolean;
  };

  provenance: {
    discoveredBy: string;
    discoveredAt: string;
    runId: string;
    redactionPolicyVersion?: number;
    notes?: string;
  };
};

export type TenantOverride = {
  capabilityId: string;
  tenantId: string;

  baseUrl?: string;
  entryPath?: string;

  steps?: Array<{
    id: string;

    target?: {
      description?: string;
      strategies: LocatorStrategy[];
    };
  }>;
};

// A deliberately compact JSON Schema. Runtime validation is implemented
// explicitly in validate.ts; this export exists for inspection/integration
// with external tooling.

export function artifactJsonSchema(): object {
  const strategy = {
    type: "object",
  };

  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title: "Computer-Use Capability Artifact",
    type: "object",

    required: [
      "schemaVersion",
      "capabilityId",
      "name",
      "description",
      "version",
      "status",
      "confidence",
      "target",
      "params",
      "outputs",
      "steps",
      "provenance",
    ],

    properties: {
      schemaVersion: {
        const: ARTIFACT_SCHEMA_VERSION,
      },

      capabilityId: {
        type: "string",
      },

      name: {
        type: "string",
      },

      description: {
        type: "string",
      },

      version: {
        type: "integer",
      },

      status: {
        enum: ["draft", "approved"],
      },

      confidence: {
        type: "number",
        minimum: 0,
        maximum: 1,
      },

      target: {
        type: "object",

        required: [
          "surfaceKind",
          "appId",
          "baseUrl",
          "entryPath",
        ],

        properties: {
          surfaceKind: {
            enum: ["web", "legacy-web", "desktop"],
          },

          appId: {
            type: "string",
          },

          vendorProduct: {
            type: "string",
          },

          tenantId: {
            type: "string",
          },

          baseUrl: {
            type: "string",
          },

          entryPath: {
            type: "string",
          },
        },
      },

      params: {
        type: "array",

        items: {
          type: "object",

          required: [
            "name",
            "type",
            "required",
            "redact",
          ],

          properties: {
            name: {
              type: "string",
            },

            type: {
              enum: ["string", "number", "boolean"],
            },

            required: {
              type: "boolean",
            },

            redact: {
              type: "boolean",
            },

            description: {
              type: "string",
            },
          },
        },
      },

      outputs: {
        type: "array",

        items: {
          type: "object",

          required: [
            "name",
            "type",
            "redact",
            "fromStep",
          ],

          properties: {
            name: {
              type: "string",
            },

            type: {
              enum: ["string", "number", "boolean"],
            },

            redact: {
              type: "boolean",
            },

            fromStep: {
              type: "string",
            },

            description: {
              type: "string",
            },
          },
        },
      },

      steps: {
        type: "array",

        items: {
          type: "object",

          required: [
            "id",
            "action",
            "risk",
          ],

          properties: {
            id: {
              type: "string",
            },

            intent: {
              type: "string",
            },

            action: {
              type: "object",

              required: ["type"],

              properties: {
                type: {
                  enum: [
                    "navigate",
                    "click",
                    "type",
                    "select",
                    "press",
                    "read",
                    "waitFor",
                    "assert",
                  ],
                },
              },
            },

            risk: {
              enum: [
                "safe",
                "risky",
                "irreversible",
              ],
            },

            checkpoint: {
              type: "object",

              properties: {
                text: {
                  type: "string",
                },
              },
            },

            target: {
              type: "object",

              properties: {
                description: {
                  type: "string",
                },

                strategies: {
                  type: "array",
                  items: strategy,
                },
              },
            },

            extractAs: {
              type: "string",
            },

            outcomes: {
              type: "array",
            },
          },
        },
      },

      globalOutcomes: {
        type: "array",
      },

      successCondition: {
        type: "object",

        properties: {
          text: {
            type: "string",
          },

          allOutputsPresent: {
            type: "boolean",
          },
        },
      },

      provenance: {
        type: "object",

        required: [
          "discoveredBy",
          "discoveredAt",
          "runId",
        ],

        properties: {
          discoveredBy: {
            type: "string",
          },

          discoveredAt: {
            type: "string",
          },

          runId: {
            type: "string",
          },

          redactionPolicyVersion: {
            type: "integer",
          },

          notes: {
            type: "string",
          },
        },
      },
    },
  };
}