import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Surface } from "../surface/surface.ts";
import { Redactor } from "../redaction.ts";
import { ensureDir, pad, runId as generateRunId } from "../util.ts";

export class Evidence {
  private stepCounter = 0;
  private redactor: Redactor;
  private captureScreens: boolean;

  readonly runDir: string;
  readonly runId: string;

  constructor(
    runDir: string,
    redactor: Redactor,
    captureScreens = true,
  ) {
    this.runDir = runDir;
    this.redactor = redactor;
    this.captureScreens = captureScreens;
    this.runId = generateRunId();

    ensureDir(this.runDir);
    ensureDir(join(this.runDir, "steps"));
  }

  event(
    type: string,
    data: Record<string, unknown> = {},
  ): void {
    const event = this.redactor.redactDeep({
      t: new Date().toISOString(),
      type,
      ...data,
    });

    appendFileSync(
      join(this.runDir, "events.jsonl"),
      `${JSON.stringify(event)}\n`,
    );
  }

  async screenshot(
    surface: Surface,
    label: string,
  ): Promise<string> {
    if (!this.captureScreens) return "";

    const buf = await surface.screenshot();

    const name =
      `steps/${pad(++this.stepCounter)}-` +
      `${label.replace(/[^a-z0-9]+/gi, "_").slice(0, 40)}.png`;

    writeFileSync(join(this.runDir, name), buf);

    return name;
  }

  async captureFailure(
    surface: Surface,
    reason: string,
  ): Promise<void> {
    ensureDir(join(this.runDir, "failure"));

    try {
      if (this.captureScreens) {
        writeFileSync(
          join(this.runDir, "failure", "screenshot.png"),
          await surface.screenshot(),
        );
      }

      writeFileSync(
        join(this.runDir, "failure", "visible-text.txt"),
        this.redactor.redact(await surface.getVisibleText()),
      );

      writeFileSync(
        join(this.runDir, "failure", "reason.txt"),
        this.redactor.redact(reason),
      );
    } catch {
      /* best effort */
    }

    this.event("failure_snapshot", {
      reason,
      url: surface.currentUrl(),
    });
  }

  writeJson(name: string, obj: unknown): void {
    writeFileSync(
      join(this.runDir, name),
      JSON.stringify(this.redactor.redactDeep(obj), null, 2),
    );
  }

  /** Artifacts are pre-redacted by construction (no raw secrets), so write verbatim. */
  writeArtifact(name: string, obj: unknown): void {
    writeFileSync(
      join(this.runDir, name),
      JSON.stringify(obj, null, 2),
    );
  }
}