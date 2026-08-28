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

  private config:
    Policy["redaction"];

  // Literal secret values (e.g. a typed password) registered at runtime.
  // These never match a regex pattern reliably, so they're masked by exact
  // substring match instead. Keyed by value -> name so redact() can find the
  // longest match first and avoid partial-masking overlapping secrets.
  private secrets = new Map<string, string>();

  constructor(
    config:
      Policy["redaction"],
  ) {
    this.config = config;

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

  registerSecret(
    name: string,
    value: string,
  ): void {
    if (!value) return;
    this.secrets.set(value, name);
  }

  redact(
    value: string,
  ): string {
    let out = value;

    const secretValues = [
      ...this.secrets.keys(),
    ].sort((a, b) => b.length - a.length);

    for (const secretValue of secretValues) {
      const name = this.secrets.get(secretValue)!;

      out = out
        .split(secretValue)
        .join(
          this.config.mask.replace(
            "{name}",
            name,
          ),
        );
    }

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