import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
} from "node:fs";
import {
  tmpdir,
} from "node:os";
import {
  join,
} from "node:path";

import type {
  Artifact,
} from "../src/artifact/schema.ts";
import {
  ArtifactStore,
  applyTemplate,
  generalizeUrl,
} from "../src/artifact/store.ts";
import {
  validateArtifact,
} from "../src/artifact/validate.ts";
import {
  matchOutcome,
} from "../src/artifact/outcomes.ts";
import {
  loadPolicy,
} from "../src/config.ts";
import {
  Guardrails,
} from "../src/guardrails.ts";
import {
  Redactor,
} from "../src/redaction.ts";
import {
  Evidence,
} from "../src/evidence/evidence.ts";
import {
  ReplayEngine,
} from "../src/replay/replay.ts";
import {
  ScriptedSurface,
} from "./scripted-surface.ts";

let passed = 0;
let failed = 0;

async function test(
  name: string,
  fn: () =>
    void | Promise<void>,
): Promise<void> {
  try {
    await fn();
    passed++;

    console.log(`✓ ${name}`);
  } catch (error) {
    failed++;

    console.error(
      `✗ ${name}`,
    );

    console.error(
      error instanceof Error
        ? error.stack ??
          error.message
        : error,
    );
  }
}

function loadArtifact(
  name: string,
): Artifact {
  return JSON.parse(
    readFileSync(
      join(
        "artifacts",
        name,
      ),
      "utf8",
    ),
  ) as Artifact;
}

const policy =
  loadPolicy();

await test(
  "golden artifacts validate",
  () => {
    for (
      const file
      of [
        "servicing.read_savings_balance.json",
        "servicing.open_subaccount.json",
      ]
    ) {
      const artifact =
        loadArtifact(file);

      const result =
        validateArtifact(
          artifact,
        );

      assert.equal(
        result.ok,
        true,
        `${file}: ${result.errors.join(
          "; ",
        )}`,
      );
    }
  },
);

await test(
  "URL generalization and substitution",
  () => {
    const generalized =
      generalizeUrl(
        "/member/12345?member=12345",
        {
          member_id:
            "12345",
        },
      );

    assert.equal(
      generalized,
      "/member/{member_id}?member={member_id}",
    );

    assert.equal(
      applyTemplate(
        generalized,
        {
          member_id:
            "99999",
        },
      ),
      "/member/99999?member=99999",
    );
  },
);

await test(
  "outcome taxonomy matches business results",
  () => {
    const artifact =
      loadArtifact(
        "servicing.read_savings_balance.json",
      );

    const match =
      matchOutcome(
        "No member found for ID 99999",
        [
          artifact.globalOutcomes,
        ],
      );

    assert.ok(match);
    assert.equal(
      match.rule.outcome,
      "NO_SUCH_MEMBER",
    );
    assert.equal(
      match.rule.classification,
      "business",
    );
  },
);

await test(
  "redaction removes sensitive values deeply",
  () => {
    const redactor =
      new Redactor(
        policy.redaction,
      );

    const result =
      redactor.redactDeep({
        ssn: "123-45-6789",
        nested: {
          email:
            "someone@example.com",
        },
      });

    const encoded =
      JSON.stringify(result);

    assert.equal(
      encoded.includes(
        "123-45-6789",
      ),
      false,
    );

    assert.equal(
      encoded.includes(
        "someone@example.com",
      ),
      false,
    );
  },
);

await test(
  "tenant override changes only drifted locators",
  () => {
    const store =
      new ArtifactStore(
        "artifacts",
      );

    const base =
      loadArtifact(
        "servicing.read_savings_balance.json",
      );

    const cuB =
      store.resolveForTenant(
        base,
        "cu-b",
      );

    assert.equal(
      cuB.target.tenantId,
      "cu-b",
    );

    assert.equal(
      cuB.target.entryPath,
      "/t/cu-b/",
    );

    const member =
      cuB.steps.find(
        (s) =>
          s.id ===
          "type-member",
      );

    assert.ok(member);

    assert.equal(
      member.target
        ?.strategies[0]
        ?.kind,
      "role",
    );

    if (
      member.target
        ?.strategies[0]
        ?.kind === "role"
    ) {
      assert.equal(
        member.target
          .strategies[0]
          .name,
        "Member Number",
      );
    }
  },
);

await test(
  "deterministic replay returns extracted balance",
  async () => {
    const artifact =
      loadArtifact(
        "servicing.read_savings_balance.json",
      );

    const surface =
      new ScriptedSurface({
        initial: "login",

        states: {
          login: {
            url:
              "http://localhost:7799/t/cu-a/",
            visibleText:
              "Operator Sign In",
          },

          lookup: {
            url:
              "http://localhost:7799/t/cu-a/lookup",
            visibleText:
              "Member Lookup Member ID Search",
          },

          member: {
            url:
              "http://localhost:7799/t/cu-a/member?memberId=12345",
            visibleText:
              "Member Detail Jamie Smith Active Savings Balance $4,210.55",
            reads: {
              "nearLabel:Savings Balance":
                "$4,210.55",
            },
          },
        },

        transitions: {
          login: [
            {
              when: {
                action:
                  "click",
              },
              to: "lookup",
            },
          ],

          lookup: [
            {
              when: {
                action:
                  "click",
              },
              to: "member",
            },
          ],
        },
      });

    const dir =
      mkdtempSync(
        join(
          tmpdir(),
          "computer-use-test-",
        ),
      );

    const redactor =
      new Redactor(
        policy.redaction,
      );

    const evidence =
      new Evidence(
        dir,
        redactor,
        false,
      );

    const replay =
      new ReplayEngine(
        surface,
        new Guardrails(policy),
        evidence,
        redactor,
      );

    const result =
      await replay.run(
        artifact,
        {
          operator_id:
            "op-jsmith",
          operator_password:
            "demo-secret",
          member_id:
            "12345",
        },
      );

    assert.equal(
      result.status,
      "success",
    );

    assert.equal(
      result.outputs
        ?.savings_balance,
      "$4,210.55",
    );
  },
);

await test(
  "business outcome is returned instead of treated as crash",
  async () => {
    const artifact =
      loadArtifact(
        "servicing.read_savings_balance.json",
      );

    const surface =
      new ScriptedSurface({
        initial: "login",

        states: {
          login: {
            url:
              "http://localhost:7799/t/cu-a/",
            visibleText:
              "Operator Sign In",
          },

          lookup: {
            url:
              "http://localhost:7799/t/cu-a/lookup",
            visibleText:
              "Member Lookup",
          },

          notFound: {
            url:
              "http://localhost:7799/t/cu-a/member?memberId=99999",
            visibleText:
              "No member found for ID 99999",
          },
        },

        transitions: {
          login: [
            {
              when: {
                action:
                  "click",
              },
              to: "lookup",
            },
          ],

          lookup: [
            {
              when: {
                action:
                  "click",
              },
              to: "notFound",
            },
          ],
        },
      });

    const dir =
      mkdtempSync(
        join(
          tmpdir(),
          "computer-use-test-",
        ),
      );

    const redactor =
      new Redactor(
        policy.redaction,
      );

    const evidence =
      new Evidence(
        dir,
        redactor,
        false,
      );

    const replay =
      new ReplayEngine(
        surface,
        new Guardrails(policy),
        evidence,
        redactor,
      );

    const result =
      await replay.run(
        artifact,
        {
          operator_id:
            "op-jsmith",
          operator_password:
            "demo-secret",
          member_id:
            "99999",
        },
      );

    assert.equal(
      result.status,
      "business_outcome",
    );

    assert.equal(
      result.businessOutcome
        ?.outcome,
      "NO_SUCH_MEMBER",
    );
  },
);

console.log(
  `\n${passed} passed, ${failed} failed`,
);

if (failed > 0) {
  process.exitCode = 1;
}