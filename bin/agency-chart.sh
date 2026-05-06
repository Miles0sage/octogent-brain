#!/usr/bin/env bash
# agency-chart.sh — validate an agency-chart.json file before spawning a swarm.
# Adapted from VRSEN/agency-swarm (MIT) — chart-as-data concept from
# `src/agency_swarm/agency/setup.py:27-262`.
set -euo pipefail

OCTOGENT_DIR="${OCTOGENT_DIR:-/root/octogent}"
CHART=""
DRY_RUN=0
ACTION="validate"

usage() {
  cat >&2 <<EOF
Usage: $0 --validate <path/to/agency-chart.json> [--dry-run]
       $0 --print <path/to/agency-chart.json>

Validates an agency-chart.json against the AgencyChart schema:
  - entryPoints: non-empty array of role names
  - sharedInstructions: non-empty string (path to AGENCY.md or inline)
  - flows: non-empty array of {from, to}; no self-edges, no duplicates, no cycles
  - every entryPoint must be referenced by at least one flow

Exit codes: 0 ok, 1 invalid chart, 2 usage error, 3 file/JSON error.
EOF
  exit 2
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --validate) ACTION="validate"; CHART="$2"; shift 2;;
    --print)    ACTION="print";    CHART="$2"; shift 2;;
    --dry-run)  DRY_RUN=1; shift;;
    -h|--help)  usage;;
    *) echo "unknown arg: $1" >&2; usage;;
  esac
done

[[ -z "$CHART" ]] && usage
[[ -f "$CHART" ]] || { echo "chart file not found: $CHART" >&2; exit 3; }

# Pretty-print mode is a no-op (no pipe to jq required for the simple shape).
if [[ "$ACTION" == "print" ]]; then
  cat "$CHART"
  exit 0
fi

if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "DRY: would invoke validateChart() over $CHART via @octogent/core"
  echo "DRY: would exit 0 if {ok: true}, 1 otherwise"
  exit 0
fi

# Delegate validation to the @octogent/core validateChart() function via a
# small inline node script. No new deps; node + the workspace are already
# present.
node \
  --experimental-strip-types \
  --no-warnings \
  -e "
    const fs = require('node:fs');
    const path = require('node:path');
    const { validateChart } = require('${OCTOGENT_DIR}/packages/core/src/domain/agencyChart.ts');
    const raw = fs.readFileSync('${CHART}', 'utf8');
    let chart;
    try { chart = JSON.parse(raw); }
    catch (e) { console.error('invalid JSON: ' + e.message); process.exit(3); }
    const result = validateChart(chart);
    if (result.ok) {
      console.log('agency-chart OK: ' + path.basename('${CHART}'));
      console.log('  entryPoints: ' + chart.entryPoints.join(', '));
      console.log('  flows: ' + chart.flows.length);
      console.log('  sharedInstructions: ' + chart.sharedInstructions);
      process.exit(0);
    }
    console.error('agency-chart INVALID: ' + path.basename('${CHART}'));
    for (const err of result.errors) console.error('  - ' + err);
    process.exit(1);
  " || exit $?
