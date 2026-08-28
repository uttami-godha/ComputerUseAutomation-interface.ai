# Computer-Use Automation System

A record-once / replay-many computer-use system for legacy back-office applications.

The system uses an LLM once during **discovery** to operate a live application and capture the workflow as a typed capability artifact. That artifact can then be replayed deterministically, with **no model in the execution loop**.

The demo application is a deliberately old-fashioned member-servicing console: login, look up a member, inspect account information, and open a sub-account. It exists to exercise the hard parts of production computer use rather than to be a polished application.

The important pieces are:

- semantic, layered element targeting rather than brittle coordinates;
- typed inputs, outputs, checkpoints, risk, and runtime outcomes;
- deterministic replay with drift detection and bounded recovery;
- multi-tenant reuse of one recorded capability;
- explicit safety policy and redaction;
- human takeover/resume when automation cannot safely continue;
- evidence for every run.

See [`REPORT.md`](./REPORT.md) for the architecture and trade-offs.

## Requirements

- Node.js >= 22.6
- npm
- Playwright / Chromium
- An Anthropic API key **only for discovery**

Deterministic replay does not require an LLM or API key.

## Install

```bash
npm install
```

Copy the example environment file if you want to run discovery:

```bash
cp .env.example .env
```

Then set:

```bash
ANTHROPIC_API_KEY=...
```

The default mock application runs on port `7799`.

## Quick start

Run the mock servicing console:

```bash
npm run mock
```

In another terminal, list the committed capabilities:

```bash
node src/cli.ts capabilities list
```

You should see at least:

```text
servicing.read_savings_balance
servicing.open_subaccount
```

The committed artifacts under `artifacts/` let replay work immediately without an LLM.

## Replay a saved capability

Read a member's savings balance:

```bash
node src/cli.ts replay \
  --capability servicing.read_savings_balance \
  --param operator_id=op-jsmith \
  --param operator_password=demo-not-a-real-secret \
  --param member_id=12345
```

The replay engine:

1. loads the saved capability artifact;
2. substitutes the supplied typed parameters;
3. navigates to the recorded entry point;
4. resolves every target through its ordered locator strategies;
5. executes each action;
6. verifies checkpoints and declared outcomes;
7. extracts declared outputs;
8. writes run evidence.

A successful run returns a result shaped like:

```json
{
  "status": "success",
  "capabilityId": "servicing.read_savings_balance",
  "outputs": {
    "savings_balance": "$4,210.55"
  }
}
```

## Runtime outcomes

Replay does not treat every unexpected page as the same kind of failure.

Artifacts declare runtime outcome rules with one of three classifications:

- `business` — a legitimate result the caller needs, such as `NO_SUCH_MEMBER` or `ACCESS_DENIED`;
- `recoverable` — a known transient/interstitial state that can be dismissed, waited through, or retried;
- `hard` — a condition where replay cannot safely continue.

For example:

```bash
node src/cli.ts replay \
  --capability servicing.read_savings_balance \
  --param operator_id=op-jsmith \
  --param operator_password=demo-not-a-real-secret \
  --param member_id=99999
```

returns a structured business outcome instead of crashing:

```json
{
  "status": "business_outcome",
  "businessOutcome": {
    "outcome": "NO_SUCH_MEMBER"
  }
}
```

Member `00000` triggers the demo idle-session interstitial and exercises bounded recovery.

## Cross-tenant replay

The same vendor product is exposed as two tenants:

- `cu-a` — the base UI;
- `cu-b` — the same product with drifted labels.

The committed tenant override changes only the known deltas:

- `Member ID` → `Member Number`
- `Search` → `Find Member`
- `Savings Balance` → `Savings Bal.`

Replay still uses the same base capability artifact.

```bash
node src/cli.ts replay \
  --capability servicing.read_savings_balance \
  --tenant cu-b \
  --param operator_id=op-jsmith \
  --param operator_password=demo-not-a-real-secret \
  --param member_id=12345
```

If a primary locator stops resolving but a lower-ranked strategy still resolves uniquely, the step succeeds and is recorded as **degraded**. That is the per-step drift signal.

## Risk gating and escalation

`servicing.open_subaccount` contains a risky `Review` step.

The committed artifact is intentionally `draft`, so unattended replay will not cross that step unless it is explicitly authorized.

For a direct approval:

```bash
node src/cli.ts replay \
  --capability servicing.open_subaccount \
  --allow-risky \
  --param operator_id=op-jsmith \
  --param operator_password=demo-not-a-real-secret \
  --param member_id=12345 \
  --param account_type=money_market \
  --param initial_deposit=500.00 \
  --param account_nickname="Vacation Fund"
```

Or exercise human takeover:

```bash
node src/cli.ts replay \
  --capability servicing.open_subaccount \
  --escalate \
  --param operator_id=op-jsmith \
  --param operator_password=demo-not-a-real-secret \
  --param member_id=12345 \
  --param account_type=money_market \
  --param initial_deposit=500.00 \
  --param account_nickname="Vacation Fund"
```

When escalation is enabled, automation transfers the single live session to the operator console. The human can inspect/operate the same page and then return control. Replay resumes from the possibly changed live state.

## Discovery

Discovery is the only path that requires an LLM.

Start the mock app, configure `ANTHROPIC_API_KEY`, then run:

```bash
node src/cli.ts discover \
  --goal "Log in, look up member 12345, and read the savings balance" \
  --capability servicing.read_savings_balance \
  --name "Read member savings balance"
```

The discovery agent receives:

- the goal;
- current URL/title;
- visible text;
- a normalized element map;
- a constrained action/tool vocabulary.

It takes one typed action at a time. The recorder converts those concrete actions into a reusable artifact containing parameter references, layered target strategies, checkpoints, outputs, risk metadata, and runtime outcomes.

The saved artifact is reviewable JSON rather than a model transcript.

Print the machine-consumable schema with:

```bash
node src/cli.ts schema
```

## Evidence

Each run creates an evidence directory containing an append-only event stream and result data. Browser-backed runs may additionally capture step screenshots and failure snapshots.

The committed `evidence/` directory demonstrates:

- successful replay;
- a legitimate not-found business outcome;
- recovery from an idle-session interstitial;
- a gated risky step → escalation → human resume → success.

For the full browser/LLM demonstration:

```bash
npm run gen-real-evidence
```

That command performs a real discovery and several browser-driven replay cases and writes them under `evidence/`.

## Running without live services

The repository also has a fully offline harness:

```bash
npm test
```

It exercises the replay engine, artifact validation, outcome taxonomy, policy/guardrails, redaction, tenant merge/canonicalization, capability catalog, recovery, drift, and escalation using a scripted `FakeSurface`.

To regenerate the committed engine-level evidence:

```bash
npm run gen-evidence
```

## Project layout

```text
src/
  surface/      Surface abstraction, Playwright web surface, layered-locator engine
  artifact/     typed artifact schema + validation + store (tenant overrides, canonicalization)
  agent/        LLM discovery loop, prompt/tools, recorder
  replay/       deterministic replay engine + error taxonomy
  escalation/   control-transfer model + human handoff (minimal operator console)
  guardrails.ts, redaction.ts, config.ts, evidence/, catalog.ts, cli.ts
  mock-app/     the legacy servicing console (zero-dep Node http)
artifacts/      committed golden capabilities + a cu-b tenant override
evidence/       committed end-to-end demonstration
tests/          in-sandbox harness + scripted surface + evidence generator
config/         policy.json (allowlist, risk rules, redaction patterns)
```

## Notes on the runtime

- **One runtime dependency: Playwright.** The Anthropic client is a thin `fetch` wrapper, the mock app is built on Node's `http`, and artifact validation is explicit. A tiny, auditable dependency surface is a deliberate choice for regulated environments (REPORT §1).
- **No build step.** Node's native TypeScript type-stripping runs `.ts` directly. The code uses only erasable TypeScript (no enums / parameter properties), so `node src/cli.ts ...` just works.
- If you see `node_modules/playwright/index.mjs` re-exporting a global path, that's a dev shim used only in the author's locked-down sandbox; a normal `npm install` replaces it. It is gitignored.