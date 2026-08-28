import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import type { Artifact, TenantOverride } from "./schema.ts";

export class ArtifactStore {
  private root: string;

  constructor(root = "artifacts") {
    this.root = root;
    mkdirSync(this.root, { recursive: true });
    mkdirSync(join(this.root, "overrides"), { recursive: true });
  }

  save(artifact: Artifact): void {
    mkdirSync(this.root, { recursive: true });
    writeFileSync(
      join(this.root, `${artifact.capabilityId}.json`),
      JSON.stringify(artifact, null, 2),
    );
  }

  load(capabilityId: string, tenantId?: string): Artifact | undefined {
    const path = join(this.root, `${capabilityId}.json`);
    if (!existsSync(path)) return undefined;

    const base = this.loadFile(path);
    return tenantId ? this.resolveForTenant(base, tenantId) : base;
  }

  loadFile(path: string): Artifact {
    return JSON.parse(readFileSync(path, "utf8")) as Artifact;
  }

  list(): Artifact[] {
    if (!existsSync(this.root)) return [];

    return readdirSync(this.root)
      .filter((name) => name.endsWith(".json"))
      .map((name) => this.loadFile(join(this.root, name)));
  }

  private loadOverride(
    capabilityId: string,
    tenantId: string,
  ): TenantOverride | undefined {
    const path = join(
      this.root,
      "overrides",
      `${capabilityId}.${tenantId}.json`,
    );

    if (!existsSync(path)) return undefined;
    return JSON.parse(readFileSync(path, "utf8")) as TenantOverride;
  }

  resolveForTenant(base: Artifact, tenantId?: string): Artifact {
    if (!tenantId) return base;

    const ov = this.loadOverride(base.capabilityId, tenantId);
    if (!ov) {
      return {
        ...base,
        target: {
          ...base.target,
          tenantId,
        },
      };
    }

    const stepOverrides = new Map(
      (ov.steps ?? []).map((s) => [s.id, s]),
    );

    return {
      ...base,
      target: {
        ...base.target,
        tenantId,
        baseUrl: ov.baseUrl ?? base.target.baseUrl,
        entryPath: ov.entryPath ?? base.target.entryPath,
      },
      steps: base.steps.map((step) => {
        const override = stepOverrides.get(step.id);
        if (!override) return step;

        return {
          ...step,
          target: step.target
            ? {
                ...step.target,
                strategies:
                  override.target?.strategies ??
                  step.target.strategies,
              }
            : override.target,
        };
      }),
    };
  }
}

// ---- URL canonicalization ---------------------------------------------------
// Recording turns concrete routes/values into parameterized templates:
//   /member?memberId=12345 -> /member?memberId={member_id}
// Replay substitutes the caller's params back in. This is what lets a route recorded on one
// concrete member/tenant generalize.

export function generalizeUrl(
  url: string,
  paramValues: Record<string, string>,
): string {
  let out = url;

  for (const [name, val] of Object.entries(paramValues)) {
    if (!val) continue;

    out = out
      .split(encodeURIComponent(val))
      .join(`{${name}}`)
      .split(val)
      .join(`{${name}}`);
  }

  return out;
}

export function applyTemplate(
  template: string,
  params: Record<string, unknown>,
): string {
  return template.replace(/\{(\w+)\}/g, (_, k: string) => {
    const v = params[k];
    return v === undefined || v === null
      ? ""
      : encodeURIComponent(String(v));
  });
}