#!/usr/bin/env node

import {
  readFileSync,
} from "node:fs";
import {
  join,
} from "node:path";

import {
  ArtifactStore,
} from "./artifact/store.ts";
import {
  artifactJsonSchema,
} from "./artifact/schema.ts";
import type {
  Artifact,
} from "./artifact/schema.ts";

import {
  CapabilityCatalog,
} from "./catalog.ts";
import {
  loadConfig,
} from "./config.ts";
import {
  Guardrails,
} from "./guardrails.ts";
import {
  Redactor,
} from "./redaction.ts";
import {
  Evidence,
} from "./evidence/evidence.ts";
import {
  WebSurface,
} from "./surface/web-surface.ts";
import {
  AnthropicClient,
} from "./llm/anthropic.ts";
import {
  DiscoveryEngine,
} from "./agent/discover.ts";
import {
  ReplayEngine,
} from "./replay/replay.ts";
import {
  HumanInTheLoop,
} from "./escalation/handoff.ts";
import {
  parseKeyValue,
  runId,
} from "./util.ts";

type Args = {
  _: string[];
  values:
    Record<string, string[]>;
  flags: Set<string>;
};

function parseArgs(
  argv: string[],
): Args {
  const out: Args = {
    _: [],
    values: {},
    flags: new Set(),
  };

  for (
    let i = 0;
    i < argv.length;
    i++
  ) {
    const token = argv[i]!;

    if (
      !token.startsWith("--")
    ) {
      out._.push(token);
      continue;
    }

    const body =
      token.slice(2);

    const eq =
      body.indexOf("=");

    if (eq >= 0) {
      const key =
        body.slice(0, eq);
      const value =
        body.slice(eq + 1);

      (
        out.values[key] ??= []
      ).push(value);

      continue;
    }

    const next =
      argv[i + 1];

    if (
      next &&
      !next.startsWith("--")
    ) {
      (
        out.values[body] ??= []
      ).push(next);

      i++;
      continue;
    }

    out.flags.add(body);
  }

  return out;
}

function one(
  args: Args,
  name: string,
): string | undefined {
  return args.values[name]?.at(-1);
}

function required(
  args: Args,
  name: string,
): string {
  const value =
    one(args, name);

  if (!value) {
    throw new Error(
      `missing --${name}`,
    );
  }

  return value;
}

function params(
  args: Args,
): Record<string, string> {
  const out:
    Record<string, string> = {};

  for (
    const item
    of args.values.param ?? []
  ) {
    const [key, value] =
      parseKeyValue(item);

    out[key] = value;
  }

  return out;
}

async function main(): Promise<void> {
  const args =
    parseArgs(
      process.argv.slice(2),
    );

  const command =
    args._[0];

  const config =
    loadConfig(
      one(args, "policy"),
    );

  const store =
    new ArtifactStore(
      "artifacts",
    );

  if (
    command === "schema"
  ) {
    console.log(
      JSON.stringify(
        artifactJsonSchema(),
        null,
        2,
      ),
    );

    return;
  }

  if (
    command ===
    "capabilities"
  ) {
    const catalog =
      new CapabilityCatalog(store);

    console.log(
      JSON.stringify(
        catalog.list(),
        null,
        2,
      ),
    );

    return;
  }

  if (
    command === "discover"
  ) {
    if (
      !config.anthropicApiKey
    ) {
      throw new Error(
        "ANTHROPIC_API_KEY is required for discovery",
      );
    }

    const capabilityId =
      required(
        args,
        "capability",
      );

    const existing =
      store.load(
        capabilityId,
      );

    if (
      existing?.status ===
        "approved" &&
      !args.flags.has(
        "force",
      )
    ) {
      throw new Error(
        `capability ${capabilityId} is already approved; ` +
          `a fresh discovery run would overwrite it. Pass --force to proceed anyway.`,
      );
    }

    const name =
      required(
        args,
        "name",
      );

    const goal =
      required(
        args,
        "goal",
      );

    const baseUrl =
      required(
        args,
        "base-url",
      );

    const entryPath =
      one(
        args,
        "entry-path",
      ) ?? "/";

    const tenantId =
      one(args, "tenant");

    const out =
      one(args, "out") ??
      "runs";

    const surface =
      await WebSurface.create({
        headed:
          args.flags.has(
            "headed",
          ),
      });

    const redactor =
      new Redactor(
        config.policy.redaction,
      );

    const guardrails =
      new Guardrails(
        config.policy,
      );

    const evidence =
      new Evidence(
        join(out, "discovery", runId()),
        redactor,
        true,
      );

    const llm =
      new AnthropicClient(
        config.anthropicApiKey,
        config.anthropicModel,
      );

    const hitl =
      args.flags.has(
        "escalate",
      )
        ? new HumanInTheLoop(
            surface,
            evidence,
          )
        : undefined;

    const agent =
      new DiscoveryEngine(
        surface,
        guardrails,
        evidence,
        redactor,
        llm,
        config.anthropicModel,
        hitl,
      );

    try {
      const result =
        await agent.run(
          goal,
          {
            capabilityId,
            name,
            target: {
              surfaceKind:
                "legacy-web",
              appId:
                "MemberServicing",
              vendorProduct:
                "MemberServicing",
              tenantId,
              baseUrl,
              entryPath,
            },
            policyVersion:
              config.policy.version,
            knownValues:
              params(args),
          },
        );

      if (
        result.artifact
      ) {
        store.save(
          result.artifact,
        );
      }

      console.log(
        JSON.stringify(
          result,
          null,
          2,
        ),
      );

      if (
        result.status !==
        "success"
      ) {
        process.exitCode = 1;
      }
    } finally {
      await hitl?.close();
      await surface.close();
    }

    return;
  }

  if (
    command === "replay"
  ) {
    const artifactPath =
      one(
        args,
        "artifact",
      );

    const tenantId =
      one(args, "tenant");

    let artifact:
      Artifact;

    if (artifactPath) {
      artifact =
        JSON.parse(
          readFileSync(
            artifactPath,
            "utf8",
          ),
        ) as Artifact;

      if (tenantId) {
        artifact =
          store.resolveForTenant(
            artifact,
            tenantId,
          );
      }
    } else {
      const capabilityId =
        required(
          args,
          "capability",
        );

      const loaded =
        store.load(
          capabilityId,
          tenantId,
        );

      if (!loaded) {
        throw new Error(
          `capability not found: ${capabilityId}`,
        );
      }

      artifact = loaded;
    }

    const out =
      one(args, "out") ??
      "runs";

    const surface =
      await WebSurface.create({
        headed:
          args.flags.has(
            "headed",
          ),
      });

    const redactor =
      new Redactor(
        config.policy.redaction,
      );

    const guardrails =
      new Guardrails(
        config.policy,
      );

    const evidence =
      new Evidence(
        join(out, "replay", runId()),
        redactor,
        true,
      );

    const hitl =
      args.flags.has(
        "escalate",
      )
        ? new HumanInTheLoop(
            surface,
            evidence,
          )
        : undefined;

    const replay =
      new ReplayEngine(
        surface,
        guardrails,
        evidence,
        redactor,
        hitl,
      );

    try {
      const result =
        await replay.run(
          artifact,
          params(args),
          {
            tenantId,
            allowRisky:
              args.flags.has(
                "allow-risky",
              ),
            confirm:
              args.flags.has(
                "confirm",
              ),
            escalateOnFailure:
              args.flags.has(
                "escalate",
              ),
          },
        );

      console.log(
        JSON.stringify(
          result,
          null,
          2,
        ),
      );

      if (
        result.status ===
        "failure"
      ) {
        process.exitCode = 1;
      }
    } finally {
      await hitl?.close();
      await surface.close();
    }

    return;
  }

  usage();

  if (command) {
    process.exitCode = 1;
  }
}

function usage(): void {
  console.log(`
Computer-Use Automation System

Commands:

  discover
    --capability <id>
    --name <name>
    --goal <goal>
    --base-url <url>
    [--entry-path <path>]
    [--tenant <id>]
    [--param name=value ...]
    [--policy <file>]
    [--out <dir>]
    [--headed]
    [--escalate]
    [--force]  (required to overwrite an already-approved capability)

  replay
    --capability <id>
      or --artifact <file>
    [--tenant <id>]
    [--param name=value ...]
    [--policy <file>]
    [--out <dir>]
    [--headed]
    [--allow-risky]
    [--confirm]
    [--escalate]

  capabilities

  schema
`);
}

main().catch((error) => {
  console.error(
    error instanceof Error
      ? error.stack ??
        error.message
      : String(error),
  );

  process.exitCode = 1;
});