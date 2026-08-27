import type {
  Artifact,
  OutcomeRule,
  Step,
  ValueRef,
} from "../artifact/schema.ts";
import type {
  Action,
  PerformResult,
  Surface,
} from "../surface/surface.ts";
import { Guardrails } from "../guardrails.ts";
import { Redactor } from "../redaction.ts";
import { Evidence } from "../evidence/evidence.ts";
import { matchOutcome } from "../artifact/outcomes.ts";
import { applyTemplate } from "../artifact/store.ts";
import type { HumanInTheLoop } from "../escalation/handoff.ts";

export type ReplayFailure = {
  stepId: string;
  code: string;
  expected?: string;
  observed?: string;
  resolution?: string;
};

export type RecoveredCondition = {
  stepId: string;
  outcome: string;
  action: string;
};

export type ReplayResult = {
  status: "success" | "business_outcome" | "failure";
  capabilityId: string;
  runId: string;
  drift: string[];
  recovered: RecoveredCondition[];
  stepsRun: number;
  outputs?: Record<string, unknown>;
  businessOutcome?: {
    outcome: string;
    message?: string;
    step?: string;
  };
  failure?: ReplayFailure;
  escalation?: {
    requested: boolean;
    resolved: boolean;
    note?: string;
    stateChanged?: boolean;
  };
};

export type ReplayOptions = {
  tenantId?: string;
  allowRisky?: boolean;
  confirm?: boolean;
  escalateOnFailure?: boolean;
};

function valueOf(
  ref: ValueRef | undefined,
  params: Record<string, unknown>,
): unknown {
  if (!ref) return undefined;

  if ("param" in ref) {
    if (!(ref.param in params)) {
      throw new Error(`missing parameter: ${ref.param}`);
    }
    return params[ref.param];
  }

  return ref.literal;
}

function asString(v: unknown): string {
  if (v === undefined || v === null) return "";
  return String(v);
}

export class ReplayEngine {
  constructor(
    private surface: Surface,
    private guardrails: Guardrails,
    private evidence: Evidence,
    private redactor: Redactor,
    private hitl?: HumanInTheLoop,
  ) {}

  private actionFor(
    step: Step,
    params: Record<string, unknown>,
  ): Action {
    const a = step.action;

    switch (a.type) {
      case "navigate":
        return {
          type: "navigate",
          url: applyTemplate(
            asString(valueOf(a.url, params)),
            params,
          ),
        };

      case "click":
        return {
          type: "click",
        };

      case "type":
        return {
          type: "type",
          value: asString(valueOf(a.value, params)),
        };

      case "select":
        return {
          type: "select",
          value: asString(valueOf(a.value, params)),
        };

      case "press":
        return {
          type: "press",
          key: a.key,
        };

      case "read":
        return {
          type: "read",
        };

      case "waitFor":
        return {
          type: "waitFor",
          text: a.text,
          ms: a.ms,
        };

      case "assert":
        return {
          type: "assert",
          text: a.text,
        };
    }
  }

  private async visibleText(): Promise<string> {
    return this.redactor.redact(
      await this.surface.getVisibleText(),
    );
  }

  private async fail(
    artifact: Artifact,
    step: Step,
    code: string,
    expected?: string,
    observed?: string,
    resolution?: string,
  ): Promise<ReplayResult> {
    const failure: ReplayFailure = {
      stepId: step.id,
      code,
      expected,
      observed,
      resolution,
    };

    this.evidence.event("replay_failure", {
      capabilityId: artifact.capabilityId,
      ...failure,
    });

    await this.evidence.captureFailure(
      this.surface,
      `${code}: ${observed ?? ""}`,
    );

    return {
      status: "failure",
      capabilityId: artifact.capabilityId,
      runId: this.evidence.runId,
      drift: [],
      recovered: [],
      stepsRun: 0,
      failure,
    };
  }

  private async recover(
    rule: OutcomeRule,
    step: Step,
  ): Promise<boolean> {
    if (
      rule.action === "dismiss_and_continue" &&
      rule.recover?.strategies?.length
    ) {
      const r = await this.surface.perform(
        { type: "click" },
        rule.recover.strategies,
      );

      if (!r.ok) return false;

      if (rule.recover.waitForText) {
        await this.surface.perform({
          type: "waitFor",
          text: rule.recover.waitForText,
        });
      }

      return true;
    }

    if (rule.action === "wait_retry") {
      await this.surface.perform({
        type: "waitFor",
        ms: rule.recover?.waitMs ?? 500,
      });
      return true;
    }

    return false;
  }

  async run(
    artifact: Artifact,
    params: Record<string, unknown>,
    opts: ReplayOptions = {},
  ): Promise<ReplayResult> {
    const outputs: Record<string, unknown> = {};
    const drift: string[] = [];
    const recovered: RecoveredCondition[] = [];

    let stepsRun = 0;

    const escalation = {
      requested: false,
      resolved: false,
      note: undefined as string | undefined,
      stateChanged: undefined as boolean | undefined,
    };

    for (const p of artifact.params ?? []) {
      if (
        p.required &&
        params[p.name] === undefined
      ) {
        throw new Error(`missing required param: ${p.name}`);
      }

      if (p.redact) {
        const v = params[p.name];
        if (v !== undefined && v !== null) {
          this.redactor.registerSecret(
            p.name,
            String(v),
          );
        }
      }
    }

    this.evidence.event("replay_start", {
      capabilityId: artifact.capabilityId,
      version: artifact.version,
      status: artifact.status,
      tenantId: opts.tenantId,
    });

    for (const step of artifact.steps) {
      stepsRun++;

      this.evidence.event("step_start", {
        id: step.id,
        intent: step.intent,
        action: step.action.type,
        risk: step.risk,
      });

      const risk = this.guardrails.classifyRisk({
        actionType: step.action.type,
        intent: step.intent,
        controlText: step.target?.description,
      });

      const handling = this.guardrails.decideHandling(
        risk,
        {
          approved: artifact.status === "approved",
          allowRisky: !!opts.allowRisky,
          confirmed: !!opts.confirm,
        },
      );

      if (handling.verdict !== "allow") {
        this.evidence.event(
          "intervention_requested",
          {
            reason:
              risk === "irreversible"
                ? "irreversible_confirmation"
                : "risky_confirmation",
            detail: handling.reason,
            stepId: step.id,
            suggested:
              "Get the live session to the required state, then resume.",
          },
        );

        if (!opts.escalateOnFailure || !this.hitl) {
          return {
            status: "failure",
            capabilityId: artifact.capabilityId,
            runId: this.evidence.runId,
            drift,
            recovered,
            stepsRun,
            failure: {
              stepId: step.id,
              code: "RISK_BLOCKED",
              expected: "approved/confirmed action",
              observed: handling.reason,
              resolution:
                "approve the artifact, pass --allow-risky/--confirm, or escalate",
            },
          };
        }

        escalation.requested = true;

        const result = await this.hitl.intervene({
          runId: this.evidence.runId,
          capabilityId: artifact.capabilityId,
          goal: artifact.description,
          stepId: step.id,
          reason:
            risk === "irreversible"
              ? "irreversible_confirmation"
              : "risky_confirmation",
          detail: handling.reason,
          url: this.surface.currentUrl(),
          screenshotPath: await this.evidence.screenshot(
            this.surface,
            `intervention-${step.id}`,
          ),
          visibleTextExcerpt: (
            await this.visibleText()
          ).slice(0, 600),
          suggested:
            "Get the live session to the required state, then resume.",
        });

        escalation.resolved = true;
        escalation.note = result.note;
        escalation.stateChanged = result.stateChanged;

        this.evidence.event(
          "intervention_resolved",
          {
            note: result.note,
            stateChanged: result.stateChanged,
          },
        );

        // Resume retries the gated step from the current live state.
      }

      const action = this.actionFor(step, params);

      if (action.type === "navigate") {
        const allowed =
          this.guardrails.checkNavigation(action.url);

        if (!allowed.allowed) {
          return this.fail(
            artifact,
            step,
            "NAVIGATION_BLOCKED",
            "allowlisted URL",
            action.url,
            allowed.reason,
          );
        }
      }

      const actionAllowed =
        this.guardrails.checkActionType(
          action.type,
        );

      if (!actionAllowed.allowed) {
        return this.fail(
          artifact,
          step,
          "ACTION_BLOCKED",
          "allowlisted action",
          action.type,
          actionAllowed.reason,
        );
      }

      let performed: PerformResult;

      try {
        performed = await this.surface.perform(
          action,
          step.target?.strategies,
        );
      } catch (e) {
        return this.fail(
          artifact,
          step,
          "ACTION_ERROR",
          step.intent,
          e instanceof Error
            ? e.message
            : String(e),
        );
      }

      if (performed.resolution) {
        const chosen =
          performed.resolution.strategyIndex ?? 0;

        if (chosen > 0 || performed.degraded) {
          const marker = `${step.id}:${
            performed.resolution.strategyKind ??
            "fallback"
          }`;

          drift.push(marker);

          this.evidence.event("drift", {
            stepId: step.id,
            strategy:
              performed.resolution.strategyKind,
            strategyIndex: chosen,
          });
        }
      }

      if (!performed.ok) {
        return this.fail(
          artifact,
          step,
          performed.code ?? "ACTION_FAILED",
          step.intent,
          performed.message,
        );
      }

      if (
        step.action.type === "read" &&
        step.extractAs
      ) {
        outputs[step.extractAs] =
          performed.value ?? "";

        this.evidence.event("extracted", {
          as: step.extractAs,
          redacted: false,
        });
      }

      let visible = await this.visibleText();

      const outcome = matchOutcome(
        visible,
        [
          step.outcomes,
          artifact.globalOutcomes,
        ],
      );

      if (outcome) {
        const rule = outcome.rule;

        if (rule.classification === "business") {
          this.evidence.event(
            "business_outcome",
            {
              outcome: rule.outcome,
              step: step.id,
            },
          );

          return {
            status: "business_outcome",
            capabilityId:
              artifact.capabilityId,
            runId: this.evidence.runId,
            drift,
            recovered,
            stepsRun,
            businessOutcome: {
              outcome: rule.outcome,
              message: rule.message,
              step: step.id,
            },
          };
        }

        if (
          rule.classification ===
          "recoverable"
        ) {
          this.evidence.event(
            "recoverable_condition",
            {
              outcome: rule.outcome,
              action: rule.action,
              step: step.id,
            },
          );

          const max =
            rule.recover?.maxRetries ?? 1;

          let ok = false;

          for (let attempt = 0; attempt < max; attempt++) {
            ok = await this.recover(
              rule,
              step,
            );

            if (!ok) continue;

            visible = await this.visibleText();

            if (
              !matchOutcome(visible, [
                [rule],
              ])
            ) {
              break;
            }
          }

          if (!ok) {
            return this.fail(
              artifact,
              step,
              "RECOVERY_FAILED",
              rule.outcome,
              outcome.matchedText,
              rule.message,
            );
          }

          recovered.push({
            stepId: step.id,
            outcome: rule.outcome,
            action: rule.action,
          });
        }

        if (rule.classification === "hard") {
          return this.fail(
            artifact,
            step,
            rule.outcome,
            step.intent,
            outcome.matchedText,
            rule.message,
          );
        }
      }

      if (step.checkpoint?.text) {
        const text = await this.visibleText();

        if (
          !text
            .toLowerCase()
            .includes(
              step.checkpoint.text.toLowerCase(),
            )
        ) {
          return this.fail(
            artifact,
            step,
            "CHECKPOINT_UNMET",
            step.checkpoint.text,
            text.slice(0, 500),
          );
        }

        this.evidence.event("checkpoint_ok", {
          id: step.id,
          text: step.checkpoint.text,
        });
      }
    }

    if (artifact.successCondition?.text) {
      const text = await this.visibleText();

      if (
        !text
          .toLowerCase()
          .includes(
            artifact.successCondition.text.toLowerCase(),
          )
      ) {
        const last =
          artifact.steps[
            artifact.steps.length - 1
          ];

        if (last) {
          return this.fail(
            artifact,
            last,
            "SUCCESS_CONDITION_UNMET",
            artifact.successCondition.text,
            text.slice(0, 500),
          );
        }
      }
    }

    if (
      artifact.successCondition
        ?.allOutputsPresent
    ) {
      for (const output of artifact.outputs ?? []) {
        if (
          outputs[output.name] ===
          undefined
        ) {
          const last =
            artifact.steps[
              artifact.steps.length - 1
            ];

          if (last) {
            return this.fail(
              artifact,
              last,
              "OUTPUT_MISSING",
              output.name,
              "undefined",
            );
          }
        }
      }
    }

    this.evidence.event("replay_success", {
      outputs: this.redactor.redactDeep(
        outputs,
      ),
    });

    return {
      status: "success",
      capabilityId: artifact.capabilityId,
      runId: this.evidence.runId,
      drift,
      recovered,
      stepsRun,
      ...(Object.keys(outputs).length
        ? { outputs }
        : {}),
      ...(escalation.requested
        ? { escalation }
        : {}),
    };
  }
}