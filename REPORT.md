# REPORT

A record-once / replay-many computer-use system for legacy back-office banking apps that expose no API. An LLM discovers a flow once; the run is captured as a typed **capability artifact**; that artifact replays deterministically with no model in the loop; a human can take over the live session when the system is stuck. This write-up covers the decisions and trade-offs.

## 1. Architecture

**Language/runtime.** TypeScript on Node >= 22.6, run **directly** via Node's native type-stripping — no build step. The code is deliberately "erasable" TS (no enums, no constructor parameter properties) so `node src/cli.ts ...` just works. **One runtime dependency: Playwright.** The LLM client is a ~40-line `fetch` wrapper over the Anthropic Messages API; the mock app is Node `http`; artifact validation is hand-written and also exported as JSON Schema. For regulated financial tooling, a tiny, auditable dependency surface that runs in locked-down environments is a feature, not a compromise — and it means the deterministic replay path pulls in no LLM SDK at all.

**Boundaries.** A single process with sharp module seams, not services. The load-bearing seam is `Surface` (`src/surface/surface.ts`): the abstraction between *how we perceive and act on a surface* and *the recorded flow*. Everything above it — the agent loop, recorder, and replay engine — is written against `Surface` and its typed `Action` / `Observation` / `LocatorStrategy` types, and **never imports Playwright directly**. Only `WebSurface` does. Discovery and replay share this one surface and the same guardrails, redactor, and evidence writer.

```text
goal -> DiscoveryEngine (LLM: observe->decide->act) -> Recorder -> Artifact (typed, versioned)
              | | |                                          |
              | | |     Guardrails <-------- shared --------> ReplayEngine (no LLM)
              | | |                                          | |
              | | Surface (Playwright web | legacy-web* | desktop*) Error taxonomy -> Result
              | | |                                            |
              | | Evidence (events.jsonl, screenshots)       HumanInTheLoop (control transfer)
```

(*designed, not built — §4.)

**Why single-process/sync.** The brief explicitly does not reward premature scaling infrastructure. Queues, workers, and a control plane are a deployment concern; the core abstractions (artifact, surface, replay result) are the same whether replay runs inline or behind a queue, so I kept it inline and spent the complexity budget on the artifact schema, the error taxonomy, and the control-transfer model — the parts being evaluated.

## 2. Artifact schema

The artifact (`src/artifact/schema.ts`) is the contract a human reviewer *and* a calling agent read. Shape and the reasoning behind each part:

- **Layered locators per target** — the robustness centerpiece. Each element carries an *ordered* list of `strategies`, most-semantic first: `role`+accessible-name → `label` / `nearLabel` (legacy label:value tables) → visible `text` → structural `css` / `xpath` → `ordinal` → `visual` (bbox coordinates). Replay uses the first that resolves to a **unique visible** node. Semantic-first survives the markup churn legacy apps actually have, generalizes across tenants, and (crucially) maps onto a desktop accessibility tree; the structural/visual fallbacks are the safety net when a surface has no clean DOM. We never record ephemeral ids or auto-generated test hooks as a primary.
- **Typed params & outputs**, each with a `redact` flag. Secret params (passwords) are supplied per invocation and stored only as references — never as literals (validation enforces this).
- **Checkpoints** (postconditions) per step and a top-level `successCondition` — replay *verifies* it made progress rather than trusting a click landed.
- **Outcome rules** (`OutcomeRule`) — declared, data-driven runtime conditions classified as `business` / `recoverable` / `hard` (§3). Step-scoped rules override global ones. Because they're data, the taxonomy is reviewable and extensible without code changes.
- **Risk class** per step (`safe` / `risky` / `irreversible`) so replay can gate mutations.
- **Governance**: `version`, `status` (`draft`→`approved`), `confidence` (set at discovery time; a natural place to feed multi-run stability data, though nothing recomputes it yet — see §7), and `provenance` (model, run id, redaction-policy version). Unattended replay of a risky step requires `approved` or an explicit flag.

Serialized as reviewable JSON in `artifacts/<capabilityId>.json`; per-tenant deltas live in `artifacts/overrides/`. `npm run schema` emits a JSON Schema for machine consumers.

## 3. Determinism & error handling

Replay (`src/replay/replay.ts`) takes an artifact + params and runs with **no LLM**. Determinism comes from: (a) the layered locator resolver, which polls until a strategy yields a *unique visible* element and records **which** strategy won; (b) explicit `waitFor` preconditions and `checkpoint` postconditions instead of fixed sleeps; and (c) values sourced only from typed params or recorded literals. When resolution falls back past the primary strategy it sets `degraded=true` — our per-step **drift signal**.

The interesting failures in a stable-UI environment are runtime conditions, so after every action replay classifies the observed state (`src/artifact/outcomes.ts`) and the **result contract** distinguishes:

- **success** — checkpoints met, declared outputs returned.
- **business_outcome** — a legitimate result the caller must know about (e.g. `NO_SUCH_MEMBER`, `ACCESS_DENIED`, `VALIDATION_ERROR`). Returned as structured data, *not* an error.
- **recoverable** — a known transient/interstitial: `dismiss_and_continue` (click a known control, then proceed to the checkpoint) or `wait_retry`. Bounded by `maxRecoveries` to avoid loops.
- **failure** (hard) — locator not found, checkpoint unmet, unexpected state, or a `hard` outcome. Emits a debuggable record: `{ stepId, code, expected, observed, resolution }` plus a failure snapshot (screenshot + DOM text). Optionally escalates (§5) before failing.

All four cases are demonstrated in `evidence/` — both as real browser-driven replays (`evidence/replay/`) and as offline engine-level runs against a scripted surface (`evidence/replay-*`, reproducible via `npm run gen-evidence`): success, not-found business outcome, recovered interstitial, and a risky/gated step that escalates to a human.

## 4. Heterogeneity & multi-tenant

**Surface abstraction, other surfaces.** The seam is `Surface.observe()` returning a normalized element map + screenshot, and `Surface.perform(action, {strategies})` resolving a target via the layered strategies. The artifact stores strategies in *surface-agnostic* terms (role, name, text, ordinal, bbox). A **legacy-web** surface adds frame traversal but reuses the same perception shape and strategies. A **desktop** surface swaps the perception provider for the OS accessibility tree — where `role`+`name` is the *native* primary and `visual` bbox the fallback — with **no change to the artifact schema or replay engine**. That's the payoff of recording semantic intent rather than DOM selectors.

**Multi-tenant reuse.** Hundreds of tenants run the same vendor product, branded/versioned differently. One **base** artifact is recorded per product; per-tenant **overrides** (`TenantOverride`) carry only the deltas — a different base URL/route prefix and step-level locator overrides for drifted labels. `ArtifactStore.resolveForTenant()` merges them. **Canonicalization** turns concrete routes/values into templates (`/member?memberId=12345` → `/member?memberId={member_id}`).

**Drift is detected, not fatal**: when a tenant's markup differs, the primary strategy fails and a structural fallback wins → the step succeeds but is flagged `degraded`; enough drift is the signal to add an override or re-review. The committed demo applies the `read_savings_balance` base artifact to tenant **cu-b** (labels "Member Number"/"Find Member"/"Savings Bal.") via an override — and, without it, still succeeds on structural fallbacks while flagging drift.

## 5. Escalation & handoff

Control is modeled explicitly (`src/escalation/`): a control flag names who holds the single live session (`automation` | `human`) — they never act simultaneously. On a stuck discovery step, a replay hard failure, or a gated risky/irreversible step, the system raises an intervention request carrying the context to act on it (capability/goal, step, reason, current URL, a screenshot, and a visible-text excerpt), transfers control to `human`, and **exposes the same live session** — the human drives the exact Playwright page the automation was using (directly in the headed browser, or via a minimal operator console that calls `surface.perform` on that page). On **resume**, control returns to `automation`, the human's note is recorded, and replay retries the gated step from the (possibly changed) live state. The operator console is intentionally minimal (the brief allows a mocked operator UI); the **control-transfer model and the handoff mechanism are real**. `evidence/replay/` includes a real end-to-end run of the full loop against the live browser: gate on the `open_subaccount` risky Review step → intervention requested with full context → I fetched the operator console's live screenshot independently to confirm it was the actual session → resumed via the same HTTP endpoint the console's form posts to → automation completed and returned the confirmation reference, with every transition in the event log.

## 6. Safety

- **Allowlist** (`config/policy.json`): only listed origins + path prefixes are navigable and only listed action types are permitted, enforced in both discovery and replay before an action runs.
- **Risk classification**: actions are `safe` / `risky` / `irreversible` from intent + the target control's text (`config/policy.json`'s `irreversibleIntents`/`riskyIntents`/`riskyControlText` word lists), plus a floor from the artifact's own recorded step risk — an irreversible match (delete/approve/update/save/post) can never be downgraded, and keyword matching is whole-word only so it doesn't false-positive inside longer words (e.g. `confirm` inside "Confirmation"). Replay gates risky steps on an `approved` artifact or an explicit `--allow-risky`, and irreversible steps on explicit confirmation; discovery refuses irreversible clicks unless the goal requires them. The demo flow deliberately stops at the sub-account **review/confirmation** screen, before the irreversible create.
- **Redaction**: secret params are stored only as **references and never logged**; a pattern scrubber masks SSNs, PANs, account numbers, and emails in *all* logs, evidence, and DOM snapshots. The committed evidence contains no password or SSN — verified.

**Limits.** The allowlist is coarse (origin + prefix), risk classification is heuristic (a production system would let the artifact pin an explicit risk per step at review time), and screenshot redaction is not pixel-level — sensitive on-screen values are masked in captured *text* but a raw screenshot could still contain them, so screenshots are gated and would need field-level masking before leaving a trust boundary.

## 7. Cuts

Deliberately left thin, with a clean seam, and what I'd build next:

- **Real browser + LLM evidence is committed** under `evidence/discovery/` and `evidence/replay/`: a genuine Claude-driven discovery run against the live mock app (screenshots, event log, the discovered artifact), plus real browser-driven replays covering success, a not-found business outcome, a recovered idle-session interstitial, cross-tenant reuse, a risk-gated failure, an `--allow-risky` override, and a complete human-escalation round trip (real control transfer, live screenshot fetched independently to confirm it was the actual session, a simulated operator resuming via the same HTTP endpoint the console form posts to, then automation completing the flow). The `evidence/replay-*` top-level directories are the complementary *engine-level* evidence (real replay engine driving a scripted surface, generated by `npm run gen-evidence`, fully offline) — kept alongside the real evidence because it exercises the taxonomy/drift/checkpoint logic in isolation and reproducibly.

  Producing the real evidence surfaced bugs no amount of code review caught: `ReplayEngine`/`DiscoveryEngine` never actually navigated to the artifact's entry point (masked entirely by the scripted-surface tests, whose fake initial state already matched); the risk classifier used plain substring matching, so `"Confirmation Ref"` false-positived on the `confirm` keyword and a `submit` mention in step *wording* silently reclassified a `risky` step as `irreversible`; and the artifact's own recorded step risk was never consulted at all, so once the false positives were fixed a genuinely risky step briefly replayed completely ungated. All fixed and reverified against the live browser. Separately, discovery's DOM perception only scanned `a/button/input/select/textarea/[role]` — a classic legacy `<table><tr><td>label</td><td>value</td></tr>` layout had *no element the model could legitimately target* for a read, so it either guessed (wrong) or correctly refused to guess and got stuck. Fixed by surfacing adjacent-label table cells as `role: "cell"` elements with a `nearLabel` strategy — directly the "deeply nested tables, non-semantic markup" case called out in the brief.
- **Operator console is minimal** (view live screenshot, navigate/click, resume). Real co-browsing (live video, input streaming, granular permissions) is out of scope by design. **Next:** stream the session and scope operator permissions.
- **Legacy-web (frames) and desktop surfaces are designed, not built** (§4). **Next:** a frame-aware web surface and an OS-accessibility desktop surface behind the same seam.
- **Assisted fallback / codegen / multi-run stability** are stubbed or absent: `confidence` and `draft`→`approved` gating exist and are enforced at replay, but nothing recomputes `confidence` from repeated runs yet, there's no bounded single-step LLM recovery on replay failure, and no page-object codegen. **Next:** a `--repeat N` stability signal feeding `confidence`, and a policy-checked, single-step assisted recovery recorded as evidence.
- **Perception is heuristic** (a DOM walker computing role/name/xpath). It's good enough for the target but a production build would use full ARIA name computation and shadow-DOM/iframe support.

Testing is where it counts: `npm test` runs a fully offline suite over the replay engine, error taxonomy, redaction, tenant merge, canonicalization, and artifact validation. `npm run typecheck` is clean, and `evidence/` carries real, not just scripted, coverage of the same paths.