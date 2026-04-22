#!/usr/bin/env bash
#
# Post-deploy CORS smoke test.
#
# Asserts that an API origin returns the expected CORS + COEP headers when
# called from a UI origin. Catches regressions like the one in
# `docs/research/staging-cors-coep-safari-rendering-audit.md` Finding 11
# (where api.taucad.dev was bound to the production app for four months
# because nothing tested the cross-origin reachability after deploy).
#
# Inputs (env vars):
#   API_URL         Required. Base URL of the API (e.g. https://api.tau.new).
#   ORIGIN          Required. UI origin that must be allowed (e.g. https://tau.new).
#   EXPECTED_ACAO   Optional. Defaults to $ORIGIN. Override only when the API
#                   intentionally allows a different origin (e.g. wildcard).
#   PROBE_PATH      Optional. Defaults to /health/ready.
#
# Exit codes:
#   0  All assertions passed.
#   1  Header mismatch (full response printed).
#   2  Network failure / curl error.
#   3  Missing required env vars.

set -euo pipefail

if [[ -z "${API_URL:-}" || -z "${ORIGIN:-}" ]]; then
  echo "ERROR: API_URL and ORIGIN env vars are required." >&2
  echo "  Usage: API_URL=https://api.tau.new ORIGIN=https://tau.new $0" >&2
  exit 3
fi

EXPECTED_ACAO="${EXPECTED_ACAO:-${ORIGIN}}"
PROBE_PATH="${PROBE_PATH:-/health/ready}"

API_URL="${API_URL%/}"
PROBE_URL="${API_URL}${PROBE_PATH}"

echo "→ Probing ${PROBE_URL} with Origin: ${ORIGIN}"

# `-i` includes headers in stdout. `-sS` keeps the output quiet on success but
# still prints any curl-level error. `--max-time` bounds the smoke test so a
# stuck upstream doesn't hang CI past the workflow timeout.
RESPONSE="$(curl -sS -i --max-time 10 -H "Origin: ${ORIGIN}" "${PROBE_URL}")" || {
  echo "ERROR: curl failed to reach ${PROBE_URL}" >&2
  exit 2
}

# Header names are case-insensitive per RFC 9110. Lowercase the header block
# for matching but keep the raw response for the failure dump so the operator
# sees exactly what the upstream returned.
HEADERS_LC="$(printf '%s' "${RESPONSE}" | awk 'BEGIN{RS="\r\n\r\n"} NR==1' | tr '[:upper:]' '[:lower:]')"

ACAO_LINE="$(printf '%s\n' "${HEADERS_LC}" | grep -E '^access-control-allow-origin:' || true)"
CORP_LINE="$(printf '%s\n' "${HEADERS_LC}" | grep -E '^cross-origin-resource-policy:' || true)"

EXPECTED_ACAO_LC="$(printf '%s' "${EXPECTED_ACAO}" | tr '[:upper:]' '[:lower:]')"

FAIL=0
if [[ "${ACAO_LINE}" != *"${EXPECTED_ACAO_LC}"* ]]; then
  echo "ERROR: missing or wrong access-control-allow-origin (expected '${EXPECTED_ACAO}')" >&2
  echo "  got: '${ACAO_LINE:-<no header>}'" >&2
  FAIL=1
fi

if [[ "${CORP_LINE}" != *"cross-origin"* ]]; then
  echo "ERROR: missing or wrong cross-origin-resource-policy (expected 'cross-origin')" >&2
  echo "  got: '${CORP_LINE:-<no header>}'" >&2
  FAIL=1
fi

if [[ "${FAIL}" -ne 0 ]]; then
  echo "" >&2
  echo "── Full response ──────────────────────────────────────────────" >&2
  printf '%s\n' "${RESPONSE}" >&2
  exit 1
fi

echo "✓ ${PROBE_URL} returned access-control-allow-origin: ${EXPECTED_ACAO}"
echo "✓ ${PROBE_URL} returned cross-origin-resource-policy: cross-origin"
