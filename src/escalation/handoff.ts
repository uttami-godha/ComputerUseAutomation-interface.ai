import * as http from "node:http";

import type { Surface } from "../surface/surface.ts";
import type { Evidence } from "../evidence/evidence.ts";

export type ControlOwner = "automation" | "human";

export type Intervention = {
  capabilityId: string;
  stepId?: string;
  goal?: string;
  reason: string;
  detail?: string;
  suggested?: string;
};

export type InterventionResult = {
  resolved: boolean;
  note?: string;
};

export type HumanAction = {
  kind: "navigate" | "click_text" | "note";
  value: string;
};

// Human-in-the-loop handoff deliberately transfers control of the same live
// Surface instead of launching a second browser/session. The operator sees a
// live screenshot, may manipulate that session, then explicitly resumes.
// Automation does nothing while control === "human".
export class HumanInTheLoop {
  private control: ControlOwner = "automation";
  private current?: Intervention;
  private server?: http.Server;
  private resumeResolve?: (note?: string) => void;

  constructor(
    private surface: Surface,
    private evidence: Evidence,
    private port = 7788,
  ) {}

  owner(): ControlOwner {
    return this.control;
  }

  async request(iv: Intervention): Promise<InterventionResult> {
    this.current = iv;
    this.control = "human";

    this.evidence.event("intervention_requested", {
      ...iv,
      url: this.surface.currentUrl(),
      consoleUrl: `http://localhost:${this.port}/`,
    });

    this.startServer();

    console.error("");
    console.error("=== HUMAN INTERVENTION REQUIRED ===");
    console.error(`Reason: ${iv.reason}`);
    if (iv.detail) console.error(`Detail: ${iv.detail}`);
    if (iv.suggested) console.error(`Suggested: ${iv.suggested}`);
    console.error(`Operator console: http://localhost:${this.port}/`);
    console.error("");

    const note = await new Promise<string | undefined>((resolve) => {
      this.resumeResolve = resolve;
    });

    this.control = "automation";

    this.evidence.event("intervention_resolved", {
      capabilityId: iv.capabilityId,
      stepId: iv.stepId,
      note,
      url: this.surface.currentUrl(),
    });

    this.current = undefined;

    return {
      resolved: true,
      note,
    };
  }

  private async applyHuman(
    a: { kind: HumanAction["kind"]; value: string },
  ): Promise<void> {
    if (a.kind === "navigate") {
      await this.surface.perform({
        type: "navigate",
        url: a.value,
      });
    } else if (a.kind === "click_text") {
      await this.surface.perform({
        type: "click",
        strategies: [
          {
            kind: "text",
            text: a.value,
            exact: false,
          },
        ],
      });
    }

    this.evidence.event("operator_action", {
      kind: a.kind,
      value: a.value,
      url: this.surface.currentUrl(),
    });
  }

  private startServer(): void {
    if (this.server) return;

    this.server = http.createServer(async (rq, rs) => {
      const u = new URL(
        rq.url ?? "/",
        `http://localhost:${this.port}`,
      );

      if (u.pathname === "/live.png") {
        rs.writeHead(200, {
          "content-type": "image/png",
        });

        rs.end(await this.surface.screenshot());
        return;
      }

      if (u.pathname === "/status") {
        rs.writeHead(200, {
          "content-type": "application/json",
        });

        rs.end(
          JSON.stringify({
            control: this.control,
            intervention: this.current,
          }),
        );

        return;
      }

      if (
        rq.method === "POST" &&
        (u.pathname === "/op" || u.pathname === "/resume")
      ) {
        const body = await readBody(rq);

        if (u.pathname === "/op") {
          const kind =
            (body.kind as HumanAction["kind"]) ?? "note";

          await this.applyHuman({
            kind,
            value: body.value ?? "",
          });

          rs.writeHead(302, {
            location: "/",
          });

          rs.end();
          return;
        }

        // resume
        rs.writeHead(200, {
          "content-type": "text/html",
        });

        const r = this.resumeResolve;

        rs.end(
          "<p>Resumed. Control returned to automation. You can close this tab.</p>",
        );

        this.resumeResolve = undefined;
        this.stopServer();

        if (r) r(body.note || undefined);

        return;
      }

      rs.writeHead(200, {
        "content-type": "text/html",
      });

      rs.end(this.renderConsole());
    });

    this.server.listen(this.port);
  }

  private stopServer(): void {
    this.server?.close();
    this.server = undefined;
  }

  private renderConsole(): string {
    const iv = this.current;

    return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>Automation intervention</title>
  <meta http-equiv="refresh" content="2">
  <style>
    body {
      font-family: system-ui, sans-serif;
      max-width: 1100px;
      margin: 24px auto;
      padding: 0 16px;
    }

    code {
      background: #eee;
      padding: 2px 5px;
    }

    form {
      margin: 10px 0;
    }

    input,
    button {
      font: inherit;
      padding: 6px;
    }
  </style>
</head>
<body>
  <h1>Human intervention required</h1>

  <p><b>Control:</b> ${escapeHtml(this.control)}</p>

  <p>
    <b>Reason:</b> ${escapeHtml(iv?.reason ?? "-")}<br>
    <b>Detail:</b> ${escapeHtml(iv?.detail ?? "-")}
  </p>

  <p>
    <b>Suggested:</b> ${escapeHtml(iv?.suggested ?? "-")}<br>
    <b>Step:</b> ${escapeHtml(iv?.stepId ?? "-")}
    &nbsp;
    <b>Goal:</b> ${escapeHtml(iv?.goal ?? "-")}
  </p>

  <p><b>Live session</b> (same page the automation was driving):</p>

  <img
    src="/live.png"
    style="border:1px solid #ccc;max-width:100%"
  >

  <h3>Operate the live session</h3>

  <form method="POST" action="/op">
    <input type="hidden" name="kind" value="navigate">
    Navigate to:
    <input
      name="value"
      size="40"
      placeholder="http://localhost:7799/..."
    >
    <button>Go</button>
  </form>

  <form method="POST" action="/op">
    <input type="hidden" name="kind" value="click_text">
    Click text:
    <input name="value" size="30">
    <button>Click</button>
  </form>

  <h3>Hand control back</h3>

  <form method="POST" action="/resume">
    Note:
    <input name="note" size="40">
    <button>Resume automation</button>
  </form>
</body>
</html>`;
  }

  async close(): Promise<void> {
    this.stopServer();
  }
}

function readBody(
  req: http.IncomingMessage,
): Promise<Record<string, string>> {
  return new Promise((resolve) => {
    let raw = "";

    req.on("data", (chunk) => {
      raw += chunk;
    });

    req.on("end", () => {
      const out: Record<string, string> = {};

      for (const pair of raw.split("&")) {
        const i = pair.indexOf("=");

        if (i < 0) continue;

        out[decodeURIComponent(pair.slice(0, i))] =
          decodeURIComponent(
            pair
              .slice(i + 1)
              .replace(/\+/g, " "),
          );
      }

      resolve(out);
    });
  });
}

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"]/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
      })[c] as string,
  );
}