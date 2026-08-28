import {
  mkdirSync,
} from "node:fs";

export function nowIso(): string {
  return new Date().toISOString();
}

export function runId(
  prefix = "run",
): string {
  const digits =
    new Date()
      .toISOString()
      .replace(
        /[-:.TZ]/g,
        "",
      )
      .slice(0, 14);

  // Split date/time with a letter (not a digit/space/hyphen) so neither
  // chunk is a run of 8+ digits - the redaction policy masks digit runs
  // that long as card/account numbers, even across spaces and hyphens.
  const stamp =
    `${digits.slice(0, 8)}T${digits.slice(8)}`;

  const random =
    Math.random()
      .toString(36)
      .slice(2, 8);

  return `${prefix}-${stamp}-${random}`;
}

export function ensureDir(
  path: string,
): void {
  mkdirSync(path, {
    recursive: true,
  });
}

export function normalize(
  value: string,
): string {
  return value
    .trim()
    .replace(/\s+/g, " ");
}

export function sleep(
  ms: number,
): Promise<void> {
  return new Promise(
    (resolve) =>
      setTimeout(resolve, ms),
  );
}

export function parseKeyValue(
  value: string,
): [string, string] {
  const index =
    value.indexOf("=");

  if (index < 1) {
    throw new Error(
      `expected name=value, got: ${value}`,
    );
  }

  return [
    value.slice(0, index),
    value.slice(index + 1),
  ];
}

export function parseParams(
  values: string[],
): Record<string, string> {
  const out:
    Record<string, string> = {};

  for (const value of values) {
    const [key, val] =
      parseKeyValue(value);

    out[key] = val;
  }

  return out;
}

export function pad(
  value: number,
  width = 3,
): string {
  return String(value).padStart(
    width,
    "0",
  );
}