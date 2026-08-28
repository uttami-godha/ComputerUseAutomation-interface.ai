import type { Tool } from "../llm/anthropic.ts";
import type { Observation } from "../surface/surface.ts";

export const SYSTEM_PROMPT = `You are a careful back-office operator for a US bank/credit union servicing console.

Rules:
- Work toward the user's stated goal and take exactly one action per turn.
- Prefer semantic controls and visible labels. Do not guess at hidden state.
- Treat money movement/account mutations (creates/closes/transfers) conservatively.
- Stop at a confirmation/review screen when possible. If a final irreversible control such as "Confirm & Create" is present and the goal doesn't require it, do not click it.
- Sensitive data (SSNs, full account/card numbers) may appear on screen. Never copy them into your reasoning, outputs, or asserts. They are redacted from logs automatically, but do not surface them.
- If you are stuck, blocked, or the screen is in an unexpected state you cannot safely handle, call "escalate" with a clear reason instead of guessing.
- When the goal is fully accomplished, call "finish" with a one-line summary.`;

export function discoveryTools(): Tool[] {
  const ref = {
    type: "string",
    description: "ref of the target element from the Elements list, e.g. 'e7'",
  };
  const intent = {
    type: "string",
    description: "why you are doing this, in plain language",
  };

  return [
    {
      name: "click",
      description: "Click an element (button, link, control).",
      input_schema: {
        type: "object",
        properties: { ref, intent },
        required: ["ref"],
      },
    },
    {
      name: "type",
      description: "Type text into a text field.",
      input_schema: {
        type: "object",
        properties: {
          ref,
          text: { type: "string" },
          secret: {
            type: "boolean",
            description: "true for passwords/secrets",
          },
          intent,
        },
        required: ["ref", "text"],
      },
    },
    {
      name: "select",
      description: "Choose an option in a dropdown/select.",
      input_schema: {
        type: "object",
        properties: {
          ref,
          value: {
            type: "string",
            description: "option value or visible label",
          },
          intent,
        },
        required: ["ref", "value"],
      },
    },
    {
      name: "navigate",
      description: "Navigate directly to a URL (must be within the allowed app).",
      input_schema: {
        type: "object",
        properties: {
          url: { type: "string" },
        },
        required: ["url"],
      },
    },
    {
      name: "read",
      description: "Extract the visible text of an element as a named output.",
      input_schema: {
        type: "object",
        properties: {
          ref,
          as: {
            type: "string",
            description: "output name, e.g. 'savings_balance'",
          },
          intent,
        },
        required: ["ref", "as"],
      },
    },
    {
      name: "assert",
      description:
        "Record a checkpoint: assert that some text is visible on the current screen.",
      input_schema: {
        type: "object",
        properties: {
          text: { type: "string" },
        },
        required: ["text"],
      },
    },
    {
      name: "wait",
      description: "Wait for text to appear, or a fixed delay.",
      input_schema: {
        type: "object",
        properties: {
          text: { type: "string" },
          ms: { type: "number" },
        },
      },
    },
    {
      name: "declare_outcome",
      description:
        "Declare a known runtime outcome rule for this capability (e.g. a not-found result or a recoverable interstitial), so deterministic replay can handle it.",
      input_schema: {
        type: "object",
        properties: {
          outcome: {
            type: "string",
            description: "MACHINE_NAME",
          },
          when_text_matches: {
            type: "string",
            description: "regex tested against visible text",
          },
          classification: {
            type: "string",
            enum: ["business", "recoverable", "hard"],
          },
          action: {
            type: "string",
            enum: ["return", "dismiss_and_continue", "wait_retry", "stop"],
          },
          message: { type: "string" },
        },
        required: ["outcome", "when_text_matches", "classification"],
      },
    },
    {
      name: "finish",
      description: "The goal is accomplished. Provide a short summary.",
      input_schema: {
        type: "object",
        properties: {
          summary: { type: "string" },
        },
        required: ["summary"],
      },
    },
    {
      name: "escalate",
      description: "Stuck/blocked - hand off to a human operator.",
      input_schema: {
        type: "object",
        properties: {
          reason: { type: "string" },
        },
        required: ["reason"],
      },
    },
  ];
}

export function formatObservation(obs: Observation, goal: string): string {
  const lines = obs.elements.map((e) => {
    const v = e.value
      ? ` value="${e.value}"`
      : e.text
        ? ` text="${e.text}"`
        : "";

    return `  [${e.ref}] ${e.role} name="${e.name}"${v}`;
  });

  return [
    `GOAL: ${goal}`,
    `URL: ${obs.url}`,
    `TITLE: ${obs.title}`,
    `VISIBLE TEXT (truncated): ${obs.visibleText.slice(0, 500)}`,
    `ELEMENTS (${obs.elements.length}):`,
    ...lines,
    `Take exactly one action toward the goal.`,
  ].join("\n");
}