#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

CAP="servicing.read_savings_balance"
GOLDEN="artifacts/${CAP}.json"
GOLDEN_BAK="$(mktemp)"
cp "$GOLDEN" "$GOLDEN_BAK"

MOCK_PID=""

cleanup() {
  if [[ -n "${MOCK_PID}" ]]; then
    kill "${MOCK_PID}" >/dev/null 2>&1 || true
  fi

  if [[ -f "${GOLDEN_BAK}" ]]; then
    cp "${GOLDEN_BAK}" "${GOLDEN}"
    rm -f "${GOLDEN_BAK}"
  fi
}

trap cleanup EXIT INT TERM

log() {
  printf '\n==> %s\n\n' "$*"
}

if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

if [[ -z "${ANTHROPIC_API_KEY:-}" ]]; then
  cat >&2 <<'EOF'
ANTHROPIC_API_KEY is not set.

Copy .env.example to .env and add a real Anthropic API key before running
real discovery evidence:

  cp .env.example .env
EOF
  exit 1
fi

HEADED_FLAG=""
if [[ "${HEADED:-0}" == "1" ]]; then
  HEADED_FLAG="--headed"
fi

mkdir -p evidence

log "Starting mock servicing console"
node src/mock-app/server.ts > /tmp/computer-use-mock.log 2>&1 &
MOCK_PID=$!

# Give the mock server a moment to bind.
sleep 1

log "1/6 DISCOVERY - real Claude discovers read_savings_balance"
node src/cli.ts discover \
  --capability "${CAP}" \
  --name "Read member savings balance" \
  --goal "Sign in to the servicing console, find member 12345, read the Savings Balance, and finish." \
  --base-url "http://localhost:7799" \
  --entry-path "/t/cu-a/" \
  --tenant "cu-a" \
  --out evidence \
  --force \
  ${HEADED_FLAG} \
  --param operator_id=op-jsmith \
  --param operator_password=demo-not-a-real-secret \
  --param member_id=12345

log "2/6 REPLAY success - member 12345"
node src/cli.ts replay --capability "${CAP}" --out evidence ${HEADED_FLAG} \
  --param operator_id=op-jsmith --param operator_password=demo-not-a-real-secret --param member_id=12345

log "3/6 REPLAY business outcome - member 99999 (not found: a legitimate result, not a crash)"
node src/cli.ts replay --capability "${CAP}" --out evidence ${HEADED_FLAG} \
  --param operator_id=op-jsmith --param operator_password=demo-not-a-real-secret --param member_id=99999 || true

log "4/6 REPLAY recoverable interstitial - member 00000"
node src/cli.ts replay --capability "${CAP}" --out evidence ${HEADED_FLAG} \
  --param operator_id=op-jsmith --param operator_password=demo-not-a-real-secret --param member_id=00000

log "5/6 REPLAY cross-tenant reuse - golden base artifact applied to tenant cu-b via override"
# Uses the preserved golden (its semantic step ids match the cu-b override); the discovered
# artifact's auto-generated step ids would not.
node src/cli.ts replay --artifact "${GOLDEN_BAK}" --tenant cu-b --out evidence ${HEADED_FLAG} \
  --param operator_id=op-jsmith --param operator_password=demo-not-a-real-secret --param member_id=12345

# REAL escalation: draft artifact with a risky step -> gated -> human takeover -> resume
log "6/6 REPLAY escalation - open_subaccount (risky 'Review' step is gated, escalates, resumes)"
node src/cli.ts replay --capability servicing.open_subaccount --escalate --out evidence ${HEADED_FLAG} \
  --param operator_id=op-jsmith --param operator_password=demo-not-a-real-secret --param member_id=12345 \
  --param account_type=money_market --param initial_deposit=500.00 --param account_nickname="Vacation Fund"

log "done - real evidence written under evidence/"
ls -1dt evidence/discovery-* evidence/replay-* 2>/dev/null | head -12 || true

cat <<EOF

Next:
- Review the new evidence/discovery-* and evidence/replay-* folders (events.jsonl + screenshots).
- The real discovered artifact is at artifacts/${CAP}.json (it overwrote the golden).
- git add evidence artifacts && git commit -m "Add real discovery + replay evidence"
EOF