import {
  ARTIFACT_SCHEMA_VERSION,
  type Artifact,
  type Step,
} from "./schema.ts";

export type ValidationResult = {
  ok: boolean;
  errors: string[];
  warnings: string[];
};

const PARAM_TYPES = new Set(["string", "number", "boolean"]);
const ACTION_TYPES = new Set(["navigate", "click", "type", "select", "press", "read", "waitFor", "assert"]);
const RISK = new Set(["safe", "risky", "irreversible"]);

export function validateArtifact(a: unknown): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  const push = (condition: boolean, message: string) => {
    if (!condition) errors.push(message);
  };

  push(!!a && typeof a === "object", "artifact must be an object");
  if (!a || typeof a !== "object") return { ok: false, errors, warnings };

  const art = a as Artifact;

  push(art.schemaVersion === ARTIFACT_SCHEMA_VERSION, `schemaVersion must be ${ARTIFACT_SCHEMA_VERSION}`);
  push(typeof art.capabilityId === "string" && art.capabilityId.length > 0, "capabilityId is required");
  push(typeof art.name === "string" && art.name.length > 0, "name is required");
  push(typeof art.description === "string", "description must be a string");
  push(typeof art.version === "number", "version must be a number");
  push(art.status === "draft" || art.status === "approved", "status must be draft or approved");
  push(typeof art.confidence === "number", "confidence must be a number");

  push(!!art.target, "target is required");
  if (art.target) {
    push(
      art.target.surfaceKind === "web" ||
        art.target.surfaceKind === "legacy-web" ||
        art.target.surfaceKind === "desktop",
      "target.surfaceKind invalid",
    );
    push(typeof art.target.appId === "string" && art.target.appId.length > 0, "target.appId required");
    push(typeof art.target.baseUrl === "string" && art.target.baseUrl.length > 0, "target.baseUrl required");
    push(typeof art.target.entryPath === "string", "target.entryPath required");
  }

  push(Array.isArray(art.params), "params must be an array");
  for (const p of art.params ?? []) {
    push(!!p.name, "param.name required");
    push(PARAM_TYPES.has(p.type), `param.type invalid for ${p.name}`);
    push(typeof p.required === "boolean", `param.required must be boolean for ${p.name}`);
    push(typeof p.redact === "boolean", `param.redact must be boolean for ${p.name}`);
  }

  const steps: Step[] = (art.steps ?? []) as Step[];
  push(Array.isArray(steps) && steps.length > 0, "steps must be a non-empty array");
  const stepIds = new Set<string>();

  for (const s of steps) {
    push(!!s.id, "step.id required");
    if (s.id) {
      push(!stepIds.has(s.id), `duplicate step id: ${s.id}`);
      stepIds.add(s.id);
    }

    push(!!s.action && ACTION_TYPES.has(s.action.type), `step ${s.id}: invalid action type`);
    push(RISK.has(s.risk), `step ${s.id}: invalid risk class`);

    if (
      s.action &&
      (s.action.type === "click" ||
        s.action.type === "type" ||
        s.action.type === "select" ||
        s.action.type === "read")
    ) {
      if (!s.target || !Array.isArray(s.target.strategies) || s.target.strategies.length === 0) {
        errors.push(`step ${s.id}: ${s.action.type} requires target.strategies`);
      } else if (!s.target.strategies.some((x) => x.kind !== "visual")) {
        warnings.push(
          `step ${s.id}: only a visual (coordinate) strategy present - brittle, prefer a semantic anchor`,
        );
      }
    }

    // Secrets must never be recorded as literals.
    if (
      s.action &&
      s.action.type === "type" &&
      "value" in s.action &&
      "literal" in s.action.value &&
      s.action.secret
    ) {
      errors.push(`step ${s.id}: secret value must be a param reference, not a literal`);
    }

    if (s.action && s.action.type === "read" && !s.extractAs) {
      warnings.push(`step ${s.id}: read step has no extractAs (produces no output)`);
    }
  }

  for (const o of art.outputs ?? []) {
    push(!!o.name, "output.name required");
    push(PARAM_TYPES.has(o.type), `output.type invalid for ${o.name}`);
    if (o.fromStep) {
      push(stepIds.has(o.fromStep), `output ${o.name}: fromStep ${o.fromStep} is not a known step id`);
    }
  }

  if (!art.provenance) push(false, "provenance is required");

  return { ok: errors.length === 0, errors, warnings };
}