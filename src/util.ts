import {
  mkdirSync,
} from "node:fs";

export function nowIso(): string {
  return new Date().toISOString();
}

export function runId(
  prefix = "run",
): string {
  const stamp =
    new Date()
      .toISOString()
      .replace(
        /[-:.TZ]/g,
        "",
      )
      .slice(0, 14);

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