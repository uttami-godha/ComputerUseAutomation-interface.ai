// Recorder - converts the discovery run's concrete actions into a typed, ref-free, replayable
// artifact. It generalizes typed values into input parameters, binds read steps to outputs,
// records the robust layered strategies for each target (never the ephemeral ref), and seeds a
// sensible baseline of outcome rules that a human/agent can review and extend.

import type {
  PerceivedElement,
  LocatorStrategy,
} from "../surface/surface.ts";

import type {
  Artifact,
  Step,
  ParamSpec,
  OutputSpec,
  OutcomeRule,
  RiskClass,
} from "../artifact/schema.ts";

import { ARTIFACT_SCHEMA_VERSION } from "../artifact/schema.ts";
import { generalizeUrl } from "../artifact/store.ts";
import { nowIso } from "../util.ts";

export class Recorder {
  private steps: Step[] = [];
  private params: ParamSpec[] = [];
  private outputs: OutputSpec[] = [];
  private declaredOutcomes: OutcomeRule[] = [];
  private paramValues: Record<string, string> = {}; // concrete value -> param name (for URL canonicalization)
  private usedNames = new Set<string>();
  private counter = 0;
  private lastAssert?: string;

  private id(prefix: string): string {
    return `${prefix}-${++this.counter}`;
  }

  private slug(name: string, fallback: string): string {
    let base = name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "");

    if (!base) base = fallback;

    let candidate = base;
    let n = 1;

    while (this.usedNames.has(candidate)) {
      candidate = `${base}_${++n}`;
    }

    this.usedNames.add(candidate);
    return candidate;
  }

  private describe(el: PerceivedElement): string {
    const primary = el.strategies[0];
    const how = primary ? `primary locator: ${primary.kind}` : "no locator";
    return `${el.role} "${el.name}" — ${how}, with ${el.strategies.length} fallback strategies`;
  }

  recordType(
    el: PerceivedElement,
    text: string,
    opts: {
      secret?: boolean;
      intent?: string;
      risk?: RiskClass;
      paramName?: string;
      required?: boolean;
    } = {},
  ): void {
    const paramName = this.slug(
      opts.paramName ?? el.name ?? "field",
      "field",
    );

    this.params.push({
      name: paramName,
      type: "string",
      required: opts.required ?? true,
      redact: !!opts.secret,
      description: opts.intent ?? `Value for ${el.name || "field"}`,
    });

    if (!opts.secret) {
      this.paramValues[paramName] = text;
    }

    const stepId = this.id("type");

    this.steps.push({
      id: stepId,
      intent: opts.intent ?? `Enter ${el.name || "value"}`,
      risk: opts.risk ?? "safe",
      action: {
        type: "type",
        value: {
          param: paramName,
        },
        ...(opts.secret ? { secret: true } : {}),
      },
      target: {
        description: this.describe(el),
        strategies: this.copyStrategies(el.strategies),
      },
      ...(this.lastAssert
        ? {
            checkpoint: {
              text: this.lastAssert,
            },
          }
        : {}),
    });
  }

  recordSelect(
    el: PerceivedElement,
    value: string,
    opts: {
      intent?: string;
      risk?: RiskClass;
      paramName?: string;
      required?: boolean;
    } = {},
  ): void {
    const paramName = this.slug(
      opts.paramName ?? el.name ?? "selection",
      "selection",
    );

    this.params.push({
      name: paramName,
      type: "string",
      required: opts.required ?? true,
      redact: false,
      description:
        opts.intent ?? `Selected value for ${el.name || "control"}`,
    });

    this.paramValues[paramName] = value;

    this.steps.push({
      id: this.id("select"),
      intent: opts.intent ?? `Choose ${el.name || "option"}`,
      risk: opts.risk ?? "safe",
      action: {
        type: "select",
        value: {
          param: paramName,
        },
      },
      target: {
        description: this.describe(el),
        strategies: this.copyStrategies(el.strategies),
      },
      ...(this.lastAssert
        ? {
            checkpoint: {
              text: this.lastAssert,
            },
          }
        : {}),
    });
  }

  recordTargetAction(
    type: "click" | "press",
    el: PerceivedElement,
    opts: {
      intent?: string;
      risk?: RiskClass;
    } = {},
  ): void {
    const step: Step = {
      id: this.id(type),
      intent:
        opts.intent ??
        `${type === "click" ? "Click" : "Press"} ${el.name || el.role}`,
      risk: opts.risk ?? "safe",
      action: {
        type,
      },
      target: {
        description: this.describe(el),
        strategies: this.copyStrategies(el.strategies),
      },
    };

    if (this.lastAssert) {
      step.checkpoint = {
        text: this.lastAssert,
      };
    }

    this.steps.push(step);
  }

  recordNavigate(url: string, intent?: string): void {
    const generalized = generalizeUrl(url, this.paramValues);

    this.steps.push({
      id: this.id("navigate"),
      intent: intent ?? `Navigate to ${generalized}`,
      risk: "safe",
      action: {
        type: "navigate",
        url: generalized,
      },
      ...(this.lastAssert
        ? {
            checkpoint: {
              text: this.lastAssert,
            },
          }
        : {}),
    });
  }

  recordRead(
    el: PerceivedElement,
    outputName: string,
    opts: {
      intent?: string;
      redact?: boolean;
      type?: "string" | "number" | "boolean";
    } = {},
  ): void {
    const name = this.slug(outputName, "output");
    const stepId = this.id("read");

    this.steps.push({
      id: stepId,
      intent: opts.intent ?? `Read ${el.name || outputName}`,
      risk: "safe",
      action: {
        type: "read",
      },
      extractAs: name,
      target: {
        description: this.describe(el),
        strategies: this.copyStrategies(el.strategies),
      },
      ...(this.lastAssert
        ? {
            checkpoint: {
              text: this.lastAssert,
            },
          }
        : {}),
    });

    this.outputs.push({
      name,
      type: opts.type ?? "string",
      redact: opts.redact ?? false,
      fromStep: stepId,
      description: opts.intent ?? `Value read from ${el.name || "page"}`,
    });
  }

  recordAssert(text: string, intent?: string): void {
    this.lastAssert = text;

    this.steps.push({
      id: this.id("assert"),
      intent: intent ?? `Verify "${text}" is visible`,
      risk: "safe",
      action: {
        type: "assert",
        text,
      },
      checkpoint: {
        text,
      },
    });
  }

  recordWait(
    text?: string,
    ms?: number,
    intent?: string,
  ): void {
    this.steps.push({
      id: this.id("wait"),
      intent:
        intent ??
        (text
          ? `Wait for "${text}"`
          : `Wait ${ms ?? 500} ms`),
      risk: "safe",
      action: {
        type: "waitFor",
        ...(text ? { text } : {}),
        ...(ms !== undefined ? { ms } : {}),
      },
      ...(text
        ? {
            checkpoint: {
              text,
            },
          }
        : {}),
    });
  }

  recordOutcome(rule: OutcomeRule): void {
    // A discovery model may encounter the same declared condition more than
    // once. Keep the artifact concise and deterministic.
    const duplicate = this.declaredOutcomes.some(
      (o) =>
        o.outcome === rule.outcome &&
        o.whenTextMatches === rule.whenTextMatches,
    );

    if (!duplicate) {
      this.declaredOutcomes.push(rule);
    }
  }

  finalize(opts: {
    capabilityId: string;
    name: string;
    description: string;
    target: Artifact["target"];
    policyVersion: number;
    model: string;
    runId: string;
    status?: Artifact["status"];
    confidence?: number;
  }): Artifact {
    const globalOutcomes = this.seedOutcomes();

    for (const declared of this.declaredOutcomes) {
      const i = globalOutcomes.findIndex(
        (existing) => existing.outcome === declared.outcome,
      );

      if (i >= 0) {
        globalOutcomes[i] = declared;
      } else {
        globalOutcomes.push(declared);
      }
    }

    const successText =
      this.lastAssert ??
      this.steps
        .slice()
        .reverse()
        .find((s) => s.checkpoint?.text)
        ?.checkpoint?.text;

    const artifact: Artifact = {
      schemaVersion: ARTIFACT_SCHEMA_VERSION,
      capabilityId: opts.capabilityId,
      name: opts.name,
      description: opts.description,
      version: 1,
      status: opts.status ?? "draft",
      confidence: opts.confidence ?? 0.7,

      target: opts.target,

      params: this.params,
      outputs: this.outputs,
      steps: this.steps,

      ...(successText
        ? {
            successCondition: {
              text: successText,
              allOutputsPresent: this.outputs.length > 0,
            },
          }
        : {
            successCondition: {
              allOutputsPresent: this.outputs.length > 0,
            },
          }),

      globalOutcomes,

      provenance: {
        discoveredBy: opts.model,
        discoveredAt: nowIso(),
        runId: opts.runId,
        redactionPolicyVersion: opts.policyVersion,
      },
    };

    return artifact;
  }

  private seedOutcomes(): OutcomeRule[] {
    return [
      {
        outcome: "SESSION_INTERSTITIAL",
        whenTextMatches: "session was idle|do you want to continue",
        classification: "recoverable",
        action: "dismiss_and_continue",
        recover: {
          strategies: [
            {
              kind: "role",
              role: "link",
              name: "Continue",
              exact: false,
            },
            {
              kind: "text",
              text: "Continue",
              exact: false,
            },
          ],
          maxRetries: 2,
        },
        message: "Dismissed idle-session interstitial and continued.",
      },
      {
        outcome: "NO_SUCH_MEMBER",
        whenTextMatches: "No member found",
        classification: "business",
        action: "return",
        message: "No member exists for the supplied id.",
      },
      {
        outcome: "ACCESS_DENIED",
        whenTextMatches: "not authorized to view",
        classification: "business",
        action: "return",
        message: "Operator is not authorized to view this member.",
      },
      {
        outcome: "SYSTEM_ERROR",
        whenTextMatches: "unexpected error|HTTP 500",
        classification: "hard",
        action: "stop",
        message: "Backend system error.",
      },
    ];
  }

  private copyStrategies(
    strategies: LocatorStrategy[],
  ): LocatorStrategy[] {
    // Never persist the ephemeral observation ref; only durable locator
    // strategies belong in the capability artifact.
    return strategies.map((strategy) => ({ ...strategy }));
  }
}