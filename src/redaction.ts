import type {
  Policy,
} from "./config.ts";

type CompiledPattern = {
  name: string;
  regex: RegExp;
};

export class Redactor {
  private patterns:
    CompiledPattern[];

  constructor(
    private config:
      Policy["redaction"],
  ) {
    this.patterns =
      config.patterns.map(
        (pattern) => ({
          name: pattern.name,
          regex: new RegExp(
            pattern.regex,
            "g",
          ),
        }),
      );
  }

  redact(
    value: string,
  ): string {
    let out = value;

    for (
      const pattern
      of this.patterns
    ) {
      pattern.regex.lastIndex = 0;

      out = out.replace(
        pattern.regex,
        () =>
          this.config.mask.replace(
            "{name}",
            pattern.name,
          ),
      );
    }

    return out;
  }

  redactDeep<T>(
    value: T,
  ): T {
    return this.walk(value) as T;
  }

  private walk(
    value: unknown,
  ): unknown {
    if (
      typeof value === "string"
    ) {
      return this.redact(value);
    }

    if (
      Array.isArray(value)
    ) {
      return value.map((x) =>
        this.walk(x),
      );
    }

    if (
      value &&
      typeof value === "object"
    ) {
      const out:
        Record<string, unknown> =
        {};

      for (
        const [key, val]
        of Object.entries(value)
      ) {
        out[key] =
          this.walk(val);
      }

      return out;
    }

    return value;
  }
}