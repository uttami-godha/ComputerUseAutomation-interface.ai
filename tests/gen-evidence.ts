import {
  mkdirSync,
  rmSync,
} from "node:fs";
import {
  join,
} from "node:path";

import type {
  Artifact,
} from "../src/artifact/schema.ts";
import {
  ArtifactStore,
} from "../src/artifact/store.ts";
import {
  loadPolicy,
} from "../src/config.ts";
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
  type ScriptedScenario,
} from "./scripted-surface.ts";

const OUT =
  "evidence";

const policy =
  loadPolicy();

const store =
  new ArtifactStore(
    "artifacts",
  );

rmSync(OUT, {
  recursive: true,
  force: true,
});

mkdirSync(OUT, {
  recursive: true,
});

async function runReplay(
  name: string,
  artifact: Artifact,
  scenario: ScriptedScenario,
  params: Record<
    string,
    unknown
  >,
): Promise<void> {
  const runDir =
    join(
      OUT,
      name,
    );

  const surface =
    new ScriptedSurface(
      scenario,
    );

  const redactor =
    new Redactor(
      policy.redaction,
    );

  const evidence =
    new Evidence(
      runDir,
      redactor,
      true,
    );

  const replay =
    new ReplayEngine(
      surface,
      policy,
      evidence,
      redactor,
    );

  const result =
    await replay.run(
      artifact,
      params,
    );

  evidence.writeJson(
    "result.json",
    result,
  );

  await surface.close();
}

const readSavings =
  store.load(
    "servicing.read_savings_balance",
  );

if (!readSavings) {
  throw new Error(
    "missing servicing.read_savings_balance artifact",
  );
}

const commonParams = {
  operator_id:
    "op-jsmith",
  operator_password:
    "demo-not-a-real-secret",
};

await runReplay(
  "replay-success",
  readSavings,
  {
    initial: "login",

    states: {
      login: {
        url:
          "http://localhost:7799/t/cu-a/",
        visibleText:
          "Operator Sign In Operator ID Password Sign In",
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
          "Member Detail Member ID 12345 Name Jamie Smith Status Active Savings Balance $4,210.55",
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
            action: "click",
          },
          to: "lookup",
        },
      ],

      lookup: [
        {
          when: {
            action: "click",
          },
          to: "member",
        },
      ],
    },
  },
  {
    ...commonParams,
    member_id:
      "12345",
  },
);

await runReplay(
  "replay-business-outcome",
  readSavings,
  {
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
          "No member found for ID 99999.",
      },
    },

    transitions: {
      login: [
        {
          when: {
            action: "click",
          },
          to: "lookup",
        },
      ],

      lookup: [
        {
          when: {
            action: "click",
          },
          to: "notFound",
        },
      ],
    },
  },
  {
    ...commonParams,
    member_id:
      "99999",
  },
);

await runReplay(
  "replay-recoverable-interstitial",
  readSavings,
  {
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

      idle: {
        url:
          "http://localhost:7799/t/cu-a/member?memberId=00000",
        visibleText:
          "Your session was idle. Do you want to continue? Continue",
      },

      member: {
        url:
          "http://localhost:7799/t/cu-a/member?memberId=00000&continued=1",
        visibleText:
          "Member Detail Savings Balance $100.00",
        reads: {
          "nearLabel:Savings Balance":
            "$100.00",
        },
      },
    },

    transitions: {
      login: [
        {
          when: {
            action: "click",
          },
          to: "lookup",
        },
      ],

      lookup: [
        {
          when: {
            action: "click",
          },
          to: "idle",
        },
      ],

      idle: [
        {
          when: {
            action: "click",
          },
          to: "member",
        },
      ],
    },
  },
  {
    ...commonParams,
    member_id:
      "00000",
  },
);

const cuB =
  store.resolveForTenant(
    readSavings,
    "cu-b",
  );

await runReplay(
  "replay-cross-tenant-cu-b",
  cuB,
  {
    initial: "login",

    states: {
      login: {
        url:
          "http://localhost:7799/t/cu-b/",
        visibleText:
          "Operator Sign In",
      },

      lookup: {
        url:
          "http://localhost:7799/t/cu-b/lookup",
        visibleText:
          "Member Lookup Member Number Find Member",
      },

      member: {
        url:
          "http://localhost:7799/t/cu-b/member?memberId=12345",
        visibleText:
          "Member Detail Savings Bal. $4,210.55",
        reads: {
          "nearLabel:Savings Bal.":
            "$4,210.55",
        },
      },
    },

    transitions: {
      login: [
        {
          when: {
            action: "click",
          },
          to: "lookup",
        },
      ],

      lookup: [
        {
          when: {
            action: "click",
          },
          to: "member",
        },
      ],
    },
  },
  {
    ...commonParams,
    member_id:
      "12345",
  },
);

console.log(
  "generated deterministic evidence under evidence/",
);