// LLM-driven discovery loop. The model observes a Surface and acts on that
// surface until the goal is met. Each observation contains a screenshot,
// compact element map and issues layered locator strategies. Concrete actions
// are executed through Surface and handed to the recorder, which turns the
// run into a deterministic replay artifact. Replay itself has no model in the
// decision loop.

import type { Artifact } from "../artifact/schema.ts";
import type {
  Action,
  Observation,
  PerceivedElement,
  Surface,
} from "../surface/surface.ts";
import { Recorder } from "./recorder.ts";
import { Guardrails } from "../guardrails.ts";
import { Evidence } from "../evidence/evidence.ts";
import { Redactor } from "../redaction.ts";
import { HumanInTheLoop } from "../escalation/handoff.ts";
import {
  AnthropicClient,
  type ContentBlock,
  type Message,
  type ToolResultBlock,
} from "../llm/anthropic.ts";
import {
  SYSTEM_PROMPT,
  discoveryTools,
  formatObservation,
} from "./prompt.ts";

export type DiscoveryTarget = {
  appId: string;
  vendorProduct?: string;
  tenantId?: string;
  baseUrl: string;
  entryPath: string;
  surfaceKind?: Artifact["target"]["surfaceKind"];
};

export type DiscoveryOptions = {
  target: DiscoveryTarget;
  maxSteps?: number;
  timeoutMs?: number;
  capabilityId: string;
  name: string;
  policyVersion: number;
};

export type DiscoveryResult = {
  status: "success" | "stuck" | "failed";
  summary: string;
  artifact?: Artifact;
  steps: number;
};

type ToolInput = Record<string, unknown>;

type HandleResult = {
  ok: boolean;
  summary: string;
  terminal?: "finish" | "escalate";
  artifact?: Artifact;
};

export class DiscoveryEngine {
  private surface: Surface;
  private guardrails: Guardrails;
  private evidence: Evidence;
  private redactor: Redactor;
  private llm: AnthropicClient;
  private model: string;
  private hitl?: HumanInTheLoop;
  private elements = new Map<string, PerceivedElement>();

  constructor(
    surface: Surface,
    guardrails: Guardrails,
    evidence: Evidence,
    redactor: Redactor,
    llm: AnthropicClient,
    model: string,
    hitl?: HumanInTheLoop,
  ) {
    this.surface = surface;
    this.guardrails = guardrails;
    this.evidence = evidence;
    this.redactor = redactor;
    this.llm = llm;
    this.model = model;
    this.hitl = hitl;
  }

  private trackObservation(obs: Observation): Observation {
    this.elements = new Map(obs.elements.map((e) => [e.ref, e]));
    return obs;
  }

  async run(
    goal: string,
    opts: DiscoveryOptions,
  ): Promise<DiscoveryResult> {
    const maxSteps = opts.maxSteps ?? 25;
    const timeoutMs = opts.timeoutMs ?? 180_000;
    const started = Date.now();

    const target: Artifact["target"] = {
      surfaceKind: opts.target.surfaceKind ?? this.surface.kind,
      appId: opts.target.appId,
      vendorProduct: opts.target.vendorProduct,
      tenantId: opts.target.tenantId,
      baseUrl: opts.target.baseUrl,
      entryPath: opts.target.entryPath,
    };

    const recorder = new Recorder();

    let obs = this.trackObservation(await this.surface.observe());

    const messages: Message[] = [
      {
        role: "user",
        content: this.obsContent(obs, goal),
      },
    ];

    this.evidence.event("discovery_start", {
      goal,
      capabilityId: opts.capabilityId,
      name: opts.name,
      model: this.model,
      target,
    });

    for (let step = 1; step <= maxSteps; step++) {
      const elapsed = Date.now() - started;

      if (elapsed >= timeoutMs) {
        const secs = Math.round(elapsed / 1000);

        this.evidence.event("intervention_requested", {
          reason: "discovery_stuck",
          detail: `timed out after ${secs}s (${step - 1} steps)`,
          goal,
          suggested: "Complete the flow manually, then resume.",
        });

        await this.evidence.captureFailure(
          this.surface,
          `discovery timed out after ${secs}s`,
        );

        return {
          status: "stuck",
          summary: `timed out after ${secs}s`,
          steps: step - 1,
        };
      }

      const response = await this.llm.message({
        system: SYSTEM_PROMPT,
        tools: discoveryTools(),
        messages,
        maxTokens: 1024,
      });

      const blocks = response.content as ContentBlock[];
      const toolUses = blocks.filter(
        (b): b is Extract<ContentBlock, { type: "tool_use" }> =>
          b.type === "tool_use",
      );

      // The contract for discovery is intentionally strict: one action per
      // model turn. Extra tool calls are rejected so the next observation
      // always corresponds to one concrete state transition.
      if (toolUses.length === 0) {
        messages.push({
          role: "assistant",
          content: blocks,
        });

        messages.push({
          role: "user",
          content: [
            {
              type: "text",
              text: "Please take exactly one action using a tool.",
            },
          ],
        });

        continue;
      }

      const primary = toolUses[0]!;

      const results: ToolResultBlock[] = [];

      for (const extra of toolUses.slice(1)) {
        results.push({
          type: "tool_result",
          tool_use_id: extra.id,
          content: [
            {
              type: "text",
              text: "Ignored - take exactly one action per turn.",
            },
          ],
          is_error: true,
        });
      }

      const handled = await this.handleTool(
        recorder,
        primary.name,
        primary.input as ToolInput,
        goal,
        target,
        opts,
      );

      if (handled.terminal === "finish") {
        const artifact =
          handled.artifact ??
          recorder.finalize({
            capabilityId: opts.capabilityId,
            name: opts.name,
            description: goal,
            target,
            policyVersion: opts.policyVersion,
            model: this.model,
            runId: this.evidence.runId,
          });

        this.evidence.event("discovery_success", {
          capabilityId: opts.capabilityId,
          steps: step,
          summary: handled.summary,
        });

        this.evidence.writeArtifact("artifact.json", artifact);

        return {
          status: "success",
          summary: handled.summary,
          artifact,
          steps: step,
        };
      }

      if (handled.terminal === "escalate") {
        if (!this.hitl) {
          this.evidence.event("intervention_requested", {
            reason: "discovery_stuck",
            detail: handled.summary,
            goal,
            suggested: "Complete the flow manually, then resume.",
          });

          await this.evidence.captureFailure(
            this.surface,
            handled.summary,
          );

          return {
            status: "stuck",
            summary: handled.summary,
            steps: step,
          };
        }

        const intervention = await this.hitl.request({
          capabilityId: opts.capabilityId,
          goal,
          stepId: `discovery-${step}`,
          reason: "discovery_stuck",
          detail: handled.summary,
          suggested: "Complete the flow manually, then resume.",
        });

        if (!intervention.resolved) {
          return {
            status: "stuck",
            summary: handled.summary,
            steps: step,
          };
        }

        // Human resumed; continue discovery from new state.
        obs = this.trackObservation(await this.surface.observe());

        messages.push({
          role: "assistant",
          content: blocks,
        });

        messages.push({
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: primary.id,
              content: this.obsContent(
                obs,
                goal,
                `After human handoff: ${handled.summary}`,
              ),
            },
            ...results,
          ],
        });

        continue;
      }

      // Observe the new state after exactly one action and feed that state
      // back as the tool result.
      obs = this.trackObservation(await this.surface.observe());

      await this.evidence.screenshot(
        this.surface,
        `after-${primary.name}`,
      );

      results.unshift({
        type: "tool_result",
        tool_use_id: primary.id,
        content: this.obsContent(obs, goal, handled.summary),
        is_error: !handled.ok,
      });

      messages.push({
        role: "assistant",
        content: blocks,
      });

      messages.push({
        role: "user",
        content: results,
      });
    }

    this.evidence.event("intervention_requested", {
      reason: "discovery_stuck",
      detail: `did not reach the goal within ${maxSteps} steps`,
      goal,
      suggested: "Complete the flow manually, then resume.",
    });

    await this.evidence.captureFailure(
      this.surface,
      `did not reach the goal within ${maxSteps} steps`,
    );

    return {
      status: "stuck",
      summary: `did not reach the goal within ${maxSteps} steps`,
      steps: maxSteps,
    };
  }

  private obsContent(
    obs: Observation,
    goal: string,
    note?: string,
  ): Array<{ type: "text"; text: string }> {
    const formatted = formatObservation(obs, goal);

    return [
      {
        type: "text",
        text: note ? `${note}\n\n${formatted}` : formatted,
      },
    ];
  }

  private async handleTool(
    recorder: Recorder,
    name: string,
    input: ToolInput,
    goal: string,
    target: Artifact["target"],
    opts: DiscoveryOptions,
  ): Promise<HandleResult> {
    const intent =
      typeof input.intent === "string" ? input.intent : undefined;

    if (name === "finish") {
      const summary =
        typeof input.summary === "string"
          ? input.summary
          : "Goal completed.";

      const artifact = recorder.finalize({
        capabilityId: opts.capabilityId,
        name: opts.name,
        description: goal,
        target,
        policyVersion: opts.policyVersion,
        model: this.model,
        runId: this.evidence.runId,
      });

      return {
        ok: true,
        terminal: "finish",
        summary,
        artifact,
      };
    }

    if (name === "escalate") {
      const reason =
        typeof input.reason === "string"
          ? input.reason
          : "Discovery requires human assistance.";

      return {
        ok: false,
        terminal: "escalate",
        summary: reason,
      };
    }

    if (name === "declare_outcome") {
      const outcome =
        typeof input.outcome === "string"
          ? input.outcome
          : "UNKNOWN_OUTCOME";

      const whenTextMatches =
        typeof input.when_text_matches === "string"
          ? input.when_text_matches
          : "";

      const classification =
        input.classification === "business" ||
        input.classification === "recoverable" ||
        input.classification === "hard"
          ? input.classification
          : "hard";

      const action =
        input.action === "return" ||
        input.action === "dismiss_and_continue" ||
        input.action === "wait_retry" ||
        input.action === "stop"
          ? input.action
          : "stop";

      recorder.recordOutcome({
        outcome,
        whenTextMatches,
        classification,
        action,
        message:
          typeof input.message === "string"
            ? input.message
            : outcome,
      });

      this.evidence.event("outcome_declared", {
        outcome,
        classification,
        action,
      });

      return {
        ok: true,
        summary: `Declared runtime outcome ${outcome}.`,
      };
    }

    if (name === "assert") {
      const text =
        typeof input.text === "string" ? input.text : "";

      if (!text) {
        return {
          ok: false,
          summary: "assert requires text",
        };
      }

      const asserted = await this.surface.perform({
        type: "assert",
        text,
      });

      if (!asserted.ok) {
        return {
          ok: false,
          summary:
            asserted.message ??
            `Assertion failed: "${text}" is not visible.`,
        };
      }

      recorder.recordAssert(text, intent);

      this.evidence.event("discovery_assert", {
        text: this.redactor.redact(text),
      });

      return {
        ok: true,
        summary: `Checkpoint recorded: ${text}`,
      };
    }

    if (name === "wait") {
      const text =
        typeof input.text === "string" ? input.text : undefined;

      const ms =
        typeof input.ms === "number" ? input.ms : undefined;

      const action: Action = text
        ? {
            type: "waitFor",
            text,
            ms: ms ?? 8000,
          }
        : {
            type: "waitFor",
            text: "",
            ms: ms ?? 500,
          };

      const check = this.guardrails.checkActionType(action.type);

      if (!check.allowed) {
        return {
          ok: false,
          summary: check.reason ?? "wait action blocked",
        };
      }

      const result = await this.surface.perform(action);

      return {
        ok: result.ok,
        summary: result.ok
          ? text
            ? `Waited for "${text}".`
            : `Waited ${ms ?? 500}ms.`
          : result.message ?? "wait failed",
      };
    }

    if (name === "navigate") {
      const url =
        typeof input.url === "string" ? input.url : "";

      if (!url) {
        return {
          ok: false,
          summary: "navigate requires url",
        };
      }

      const nav = this.guardrails.checkNavigation(url);

      if (!nav.allowed) {
        return {
          ok: false,
          summary: nav.reason ?? "navigation blocked",
        };
      }

      const action: Action = {
        type: "navigate",
        url,
      };

      const result = await this.surface.perform(action);

      if (result.ok) {
        recorder.recordNavigate(url, intent);
      }

      return {
        ok: result.ok,
        summary: result.ok
          ? `Navigated to ${url}.`
          : result.message ?? "navigation failed",
      };
    }

    const ref =
      typeof input.ref === "string" ? input.ref : "";

    if (!ref) {
      return {
        ok: false,
        summary: `${name} requires a target ref`,
      };
    }

    const element = this.elements.get(ref);

    if (!element) {
      return {
        ok: false,
        summary: `Unknown or stale element ref: ${ref}`,
      };
    }

    const controlText = `${element.name ?? ""} ${element.role ?? ""}`.trim();

    if (name === "click") {
      const risk = this.guardrails.classifyRisk({
        actionType: "click",
        intent,
        controlText,
      });

      if (risk === "irreversible") {
        return {
          ok: false,
          terminal: "escalate",
          summary:
            "Irreversible action requires explicit human confirmation.",
        };
      }

      const action: Action = {
        type: "click",
      };

      const result = await this.surface.perform(action, element.strategies);

      if (result.ok) {
        recorder.recordTargetAction(
          "click",
          element,
          {
            intent,
            risk,
          },
        );
      }

      return this.performSummary("click", element, result.ok, result.message);
    }

    if (name === "type") {
      const text =
        typeof input.text === "string" ? input.text : "";

      const secret = input.secret === true;

      if (secret) {
        this.redactor.registerSecret(
          element.name || "secret",
          text,
        );
      }

      const risk = this.guardrails.classifyRisk({
        actionType: "type",
        intent,
        controlText,
      });

      const action: Action = {
        type: "type",
        text,
      };

      const result = await this.surface.perform(action, element.strategies);

      if (result.ok) {
        recorder.recordType(
          element,
          text,
          {
            intent,
            secret,
            risk,
          },
        );
      }

      return this.performSummary("type", element, result.ok, result.message);
    }

    if (name === "select") {
      const value =
        typeof input.value === "string" ? input.value : "";

      const risk = this.guardrails.classifyRisk({
        actionType: "select",
        intent,
        controlText,
      });

      const action: Action = {
        type: "select",
        value,
      };

      const result = await this.surface.perform(action, element.strategies);

      if (result.ok) {
        recorder.recordSelect(
          element,
          value,
          {
            intent,
            risk,
          },
        );
      }

      return this.performSummary(
        "select",
        element,
        result.ok,
        result.message,
      );
    }

    if (name === "read") {
      const as =
        typeof input.as === "string" ? input.as : "";

      if (!as) {
        return {
          ok: false,
          summary: "read requires an output name",
        };
      }

      const action: Action = {
        type: "read",
      };

      const result = await this.surface.perform(action, element.strategies);

      if (!result.ok) {
        return {
          ok: false,
          summary: result.message ?? "read failed",
        };
      }

      const value = result.value ?? "";

      recorder.recordRead(
        element,
        as,
        {
          intent,
        },
      );

      this.evidence.event("discovery_read", {
        output: as,
        value: this.redactor.redact(value),
      });

      return {
        ok: true,
        summary: `Read ${as}.`,
      };
    }

    return {
      ok: false,
      summary: `Unsupported discovery tool: ${name}`,
    };
  }

  private performSummary(
    kind: string,
    element: PerceivedElement,
    ok: boolean,
    message?: string,
  ): HandleResult {
    if (!ok) {
      return {
        ok: false,
        summary:
          message ??
          `${kind} failed on ${element.name || element.role}`,
      };
    }

    return {
      ok: true,
      summary: `${kind} succeeded on ${element.name || element.role}.`,
    };
  }
}