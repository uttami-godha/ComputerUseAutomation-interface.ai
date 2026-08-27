// Surface is the boundary between the automation system and whatever UI is
// being operated. Discovery and replay depend on this interface, not directly
// on Playwright, which keeps the core deterministic and testable.

export type LocatorStrategy =
  | {
      kind: "role";
      role: string;
      name?: string;
      exact?: boolean;
    }
  | {
      kind: "label";
      text: string;
      exact?: boolean;
    }
  | {
      kind: "text";
      text: string;
      exact?: boolean;
    }
  | {
      kind: "nearLabel";
      label: string;
    }
  | {
      kind: "css";
      selector: string;
    }
  | {
      kind: "xpath";
      selector: string;
    }
  | {
      kind: "visual";
      x: number;
      y: number;
    };

export type PerceivedElement = {
  ref: string;
  role: string;
  name: string;
  value?: string;
  text?: string;
  strategies: LocatorStrategy[];
};

export type Observation = {
  url: string;
  title: string;
  visibleText: string;
  elements: PerceivedElement[];
  issues?: string[];
};

export type Action =
  | {
      type: "navigate";
      url: string;
    }
  | {
      type: "click";
    }
  | {
      type: "type";
      text: string;
    }
  | {
      type: "select";
      value: string;
    }
  | {
      type: "press";
      key: string;
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

export type LocatorResolution = {
  strategyIndex: number;
  strategyKind: LocatorStrategy["kind"];
};

export type PerformResult = {
  ok: boolean;
  value?: string;
  code?: string;
  message?: string;
  resolution?: LocatorResolution;
  degraded?: boolean;
};

export interface Surface {
  currentUrl(): string;

  observe(): Promise<Observation>;

  perform(
    action: Action,
    strategies?: LocatorStrategy[],
  ): Promise<PerformResult>;

  getVisibleText(): Promise<string>;

  screenshot(): Promise<Buffer>;

  close(): Promise<void>;
}