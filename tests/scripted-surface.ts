import type {
  Action,
  LocatorStrategy,
  Observation,
  PerformResult,
  Surface,
} from "../src/surface/surface.ts";

export type ScriptedState = {
  url: string;
  title?: string;
  visibleText: string;
  reads?: Record<string, string>;
};

export type ScriptedTransition = {
  when: {
    action: Action["type"];
    text?: string;
    value?: string;
  };
  to?: string;
  result?: Partial<PerformResult>;
};

export type ScriptedScenario = {
  initial: string;
  states: Record<string, ScriptedState>;
  transitions?: Record<
    string,
    ScriptedTransition[]
  >;
};

export class ScriptedSurface
  implements Surface
{
  readonly kind = "web" as const;

  private stateId: string;
  private scenario: ScriptedScenario;

  readonly actions: {
    action: Action;
    strategies?: LocatorStrategy[];
  }[] = [];

  constructor(
    scenario: ScriptedScenario,
  ) {
    this.scenario = scenario;
    this.stateId = scenario.initial;

    if (!scenario.states[this.stateId]) {
      throw new Error(
        `unknown initial scripted state: ${this.stateId}`,
      );
    }
  }

  private state(): ScriptedState {
    const state =
      this.scenario.states[this.stateId];

    if (!state) {
      throw new Error(
        `unknown scripted state: ${this.stateId}`,
      );
    }

    return state;
  }

  currentUrl(): string {
    return this.state().url;
  }

  async observe(): Promise<Observation> {
    const state = this.state();

    return {
      url: state.url,
      title: state.title ?? "",
      visibleText:
        state.visibleText,
      elements: [],
    };
  }

  async getVisibleText(): Promise<string> {
    return this.state().visibleText;
  }

  async screenshot(): Promise<Buffer> {
    // Tests do not need actual pixels. A deterministic buffer is enough for
    // Evidence.captureFailure / screenshot plumbing.
    return Buffer.from(
      `scripted screenshot: ${this.stateId}\n`,
      "utf8",
    );
  }

  async perform(
    action: Action,
    strategies?: LocatorStrategy[],
  ): Promise<PerformResult> {
    this.actions.push({
      action,
      strategies,
    });

    if (action.type === "navigate") {
      return this.performNavigate(
        action.url,
      );
    }

    if (action.type === "waitFor") {
      if (action.text) {
        const visible =
          this.state()
            .visibleText
            .toLowerCase();

        if (
          !visible.includes(
            action.text.toLowerCase(),
          )
        ) {
          return {
            ok: false,
            code: "WAIT_TIMEOUT",
            message:
              `text not visible: ${action.text}`,
          };
        }
      }

      return {
        ok: true,
      };
    }

    if (action.type === "assert") {
      const visible =
        this.state()
          .visibleText
          .toLowerCase();

      if (
        !visible.includes(
          action.text.toLowerCase(),
        )
      ) {
        return {
          ok: false,
          code: "ASSERTION_FAILED",
          message:
            `expected visible text: ${action.text}`,
        };
      }

      return {
        ok: true,
      };
    }

    const transitions =
      this.scenario.transitions?.[
        this.stateId
      ] ?? [];

    const transition =
      transitions.find((t) =>
        matches(t, action),
      );

    if (transition) {
      if (transition.to) {
        if (
          !this.scenario.states[
            transition.to
          ]
        ) {
          throw new Error(
            `transition points to unknown state: ${transition.to}`,
          );
        }

        this.stateId =
          transition.to;
      }

      return {
        ok: true,
        resolution: {
          strategyIndex: 0,
          strategyKind:
            strategies?.[0]?.kind ??
            "css",
        },
        ...transition.result,
      };
    }

    if (action.type === "read") {
      const state = this.state();

      const first =
        strategies?.[0];

      const key =
        strategyKey(first);

      const value =
        (key
          ? state.reads?.[key]
          : undefined) ??
        Object.values(
          state.reads ?? {},
        )[0];

      if (value === undefined) {
        return {
          ok: false,
          code: "TARGET_NOT_FOUND",
          message:
            "no scripted read value configured",
        };
      }

      return {
        ok: true,
        value,
        resolution: {
          strategyIndex: 0,
          strategyKind:
            first?.kind ?? "css",
        },
      };
    }

    // Type/select/press/click actions without an explicit transition are
    // treated as successful no-op interactions. This keeps scenarios focused
    // on state changes rather than reproducing a browser DOM.
    return {
      ok: true,
      resolution: {
        strategyIndex: 0,
        strategyKind:
          strategies?.[0]?.kind ??
          "css",
      },
    };
  }

  private performNavigate(
    url: string,
  ): PerformResult {
    const direct =
      Object.entries(
        this.scenario.states,
      ).find(
        ([, state]) =>
          state.url === url,
      );

    if (direct) {
      this.stateId = direct[0];

      return {
        ok: true,
      };
    }

    const transitions =
      this.scenario.transitions?.[
        this.stateId
      ] ?? [];

    const transition =
      transitions.find(
        (t) =>
          t.when.action ===
            "navigate" &&
          (!t.when.value ||
            t.when.value === url),
      );

    if (transition?.to) {
      this.stateId =
        transition.to;
    }

    return {
      ok: true,
      ...transition?.result,
    };
  }

  async close(): Promise<void> {
    // Nothing to release.
  }
}

function matches(
  transition: ScriptedTransition,
  action: Action,
): boolean {
  if (
    transition.when.action !==
    action.type
  ) {
    return false;
  }

  if (
    transition.when.text !==
    undefined
  ) {
    const text =
      action.type === "assert" ||
      action.type === "waitFor"
        ? action.text
        : undefined;

    if (
      text !== transition.when.text
    ) {
      return false;
    }
  }

  if (
    transition.when.value !==
    undefined
  ) {
    let value:
      string | undefined;

    if (
      action.type === "type"
    ) {
      value = action.text;
    } else if (
      action.type === "select"
    ) {
      value = action.value;
    } else if (
      action.type === "navigate"
    ) {
      value = action.url;
    } else if (
      action.type === "press"
    ) {
      value = action.key;
    }

    if (
      value !==
      transition.when.value
    ) {
      return false;
    }
  }

  return true;
}

function strategyKey(
  strategy:
    | LocatorStrategy
    | undefined,
): string | undefined {
  if (!strategy) {
    return undefined;
  }

  switch (strategy.kind) {
    case "role":
      return [
        "role",
        strategy.role,
        strategy.name ?? "",
      ].join(":");

    case "label":
      return `label:${strategy.text}`;

    case "text":
      return `text:${strategy.text}`;

    case "nearLabel":
      return `nearLabel:${strategy.label}`;

    case "css":
      return `css:${strategy.selector}`;

    case "xpath":
      return `xpath:${strategy.selector}`;

    case "visual":
      return `visual:${strategy.x},${strategy.y}`;
  }
}
