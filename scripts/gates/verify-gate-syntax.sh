#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# verify-gate-syntax.sh
#
# "Guards for the guards": syntax-parses every script under scripts/gates/ so
# a gate with a broken syntax cannot silently no-op in CI. This is a
# meta-validator, NOT one of the counted gates (CSR-003) — it is not listed
# alongside them in the "## Gates" section of this directory's README.
#
# Extension routing is a CLOSED, ENUMERATED set. The failure branch is
# reached only by a file whose extension falls through this list — never by
# a file the author simply did not anticipate being non-script:
#   .sh                        bash -n
#   .mjs, .js, .cjs             node --check
#   .ts                        explicitly SKIPPED with a named reason (no TS
#                               parse path in a bash meta-validator without a
#                               toolchain dependency; the framework's own
#                               test run covers .ts)
#   .md, .json, .txt, (none)   skipped via an explicit allowlist — non-script
#                               assets, never routed to the failure branch
#   anything else               exit non-zero — a genuinely unknown
#                               script-shaped file must not pass silently
#
# Path exclusions (walked around entirely, not just skipped-and-counted):
#   scripts/gates/fixtures/     deliberately-malformed sample sources used by
#                               the gates' own self-tests, not gate code
#   scripts/gates/.baselines/   repo-owned baseline data, not gate code
#
# Configuration (env vars, all optional):
#   GATE_SYNTAX_ROOT   Repo root; scripts/gates/ is resolved beneath it.
#                       Default: $(pwd).
#
# Error handling: a file that fails its parse check exits non-zero with the
# file and parser output named — silently skipping the file with the syntax
# error is the fast-exit path this script exists to close. Fail-closed: any
# tool error (missing node, missing scripts/gates/ dir) also exits non-zero.
#
# Exit codes: 0 = every parsed file is clean, 1 = a parse failure, an
# unrecognised script-shaped extension, or a tool/config error.
# ---------------------------------------------------------------------------
set -euo pipefail

ROOT_DIR="${GATE_SYNTAX_ROOT:-$(pwd)}"
GATES_DIR="$ROOT_DIR/scripts/gates"

echo "--- verify-gate-syntax ---"

if [ ! -d "$GATES_DIR" ]; then
  echo "[GATE] gate-syntax: $GATES_DIR missing — fail closed" >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "[GATE] gate-syntax: node not found on PATH — fail closed" >&2
  exit 1
fi

echo "[GATE] gate-syntax: path-excluded dirs: fixtures/ .baselines/"

PARSED_COUNT=0
TS_SKIPPED=0
ALLOW_SKIPPED=0
UNKNOWN_COUNT=0
PARSE_FAILURES=0

while IFS= read -r file; do
  base="${file##*/}"
  case "$base" in
    *.sh)
      if OUTPUT=$(bash -n "$file" 2>&1); then
        PARSED_COUNT=$((PARSED_COUNT + 1))
      else
        echo "  [FAIL] $file (bash -n)"
        echo "$OUTPUT" | sed 's/^/         /'
        PARSE_FAILURES=$((PARSE_FAILURES + 1))
      fi
      ;;
    *.mjs|*.js|*.cjs)
      if OUTPUT=$(node --check "$file" 2>&1); then
        PARSED_COUNT=$((PARSED_COUNT + 1))
      else
        echo "  [FAIL] $file (node --check)"
        echo "$OUTPUT" | sed 's/^/         /'
        PARSE_FAILURES=$((PARSE_FAILURES + 1))
      fi
      ;;
    *.ts)
      echo "  [skip] $file (.ts — no TS parse path in a bash meta-validator without a toolchain dependency; covered by the framework's own test run)"
      TS_SKIPPED=$((TS_SKIPPED + 1))
      ;;
    *.md|*.json|*.txt)
      ALLOW_SKIPPED=$((ALLOW_SKIPPED + 1))
      ;;
    *.*)
      echo "  [FAIL] $file (unrecognised extension — not in the enumerated allowlist, must not pass silently)"
      UNKNOWN_COUNT=$((UNKNOWN_COUNT + 1))
      ;;
    *)
      # Extensionless — allowlisted as a non-script asset.
      ALLOW_SKIPPED=$((ALLOW_SKIPPED + 1))
      ;;
  esac
done < <(find "$GATES_DIR" \( -path "$GATES_DIR/fixtures" -o -path "$GATES_DIR/.baselines" \) -prune -o -type f -print)

echo ""
echo "[GATE] gate-syntax: parsed=$PARSED_COUNT skipped_allowlist=$ALLOW_SKIPPED skipped_ts=$TS_SKIPPED failures=$PARSE_FAILURES unknown=$UNKNOWN_COUNT"

if [ "$PARSE_FAILURES" -gt 0 ] || [ "$UNKNOWN_COUNT" -gt 0 ]; then
  echo "[BLOCKING FAIL] One or more scripts under scripts/gates/ failed syntax validation."
  exit 1
fi

echo "[PASS] All $PARSED_COUNT parsed scripts under scripts/gates/ are syntactically clean."
exit 0
