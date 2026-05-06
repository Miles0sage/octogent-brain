#!/usr/bin/env bash
# spawn-team.sh — spawn a coordinator + N specialized BriefingDeck role agents
# under one octogent tentacle. See ~/.claude/skills/briefingdeck-spawn-team/.
#
# --vote / --chart additions adapted from VRSEN/agency-swarm (MIT) —
# voting prompt template + agency-chart validation flow.
set -euo pipefail

OCTOGENT_DIR="${OCTOGENT_DIR:-/root/octogent}"
API_PORT="${OCTOGENT_API_PORT:-8788}"
TOPIC=""
TENTACLE=""
ROLES="research,builder,reviewer"
DRY_RUN=0
VOTE=0
CHART_PATH=""

usage() { cat >&2 <<EOF
Usage: $0 --topic "<topic>" --tentacle <name> [--roles research,builder,reviewer]
            [--vote] [--chart <path/to/agency-chart.json>] [--dry-run]
Valid roles: research builder reviewer synthesizer planner

  --vote    Use the swarm-vote-parent template; coord fans out the topic to all
            specialists and picks the highest-scoring response.
  --chart   Validate the named agency-chart.json before spawning. If validation
            fails, abort with a non-zero exit.
EOF
exit 1; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --topic) TOPIC="$2"; shift 2;;
    --tentacle) TENTACLE="$2"; shift 2;;
    --roles) ROLES="$2"; shift 2;;
    --vote) VOTE=1; shift;;
    --chart) CHART_PATH="$2"; shift 2;;
    --dry-run) DRY_RUN=1; shift;;
    -h|--help) usage;;
    *) echo "unknown arg: $1" >&2; usage;;
  esac
done

[[ -z "$TOPIC" || -z "$TENTACLE" ]] && usage

# 1. Optional: validate the agency chart up front.
if [[ -n "$CHART_PATH" ]]; then
  if [[ "$DRY_RUN" -eq 1 ]]; then
    echo "DRY: bash ${OCTOGENT_DIR}/bin/agency-chart.sh --validate '$CHART_PATH' --dry-run"
  else
    bash "${OCTOGENT_DIR}/bin/agency-chart.sh" --validate "$CHART_PATH"
  fi
fi

# 2. Confirm octogent is up (skip in dry-run)
if [[ "$DRY_RUN" -eq 0 ]]; then
  curl -fsS "http://localhost:${API_PORT}/" >/dev/null \
    || { echo "octogent not reachable on :${API_PORT}" >&2; exit 2; }
fi

OCT="node ${OCTOGENT_DIR}/bin/octogent"

# Pick the coordinator template based on the --vote flag. swarm-parent is the
# upstream merge-style coordinator; swarm-vote-parent is the fan-out + score
# + pick variant lifted from agency-swarm semantics.
COORD_TEMPLATE="swarm-parent"
if [[ "$VOTE" -eq 1 ]]; then
  COORD_TEMPLATE="swarm-vote-parent"
fi

# Build the {{specialists}} markdown listing for vote mode. We render the same
# `- {name}: {description}` shape that agency-swarm's SendMessage uses
# (`tools/send_message.py:166-180`). One-line descriptions are intentionally
# stable; if Lane-B updates an agent file, this line should be re-derived.
specialists_block_for_role() {
  local role="$1"
  case "$role" in
    research)    echo "- bd-research: investigates the topic against Lore + Perplexity / Exa / Context7; cites priors; read-only on source.";;
    builder)     echo "- bd-builder: ships code under TDD; runs .venv/bin/pytest before declaring done; modifies source.";;
    reviewer)    echo "- bd-reviewer: read-only structured review with severity-rated comments; does not modify source.";;
    synthesizer) echo "- bd-synthesizer: NotebookLM-style paragraphs with span-level verbatim citations; aggregates sources.";;
    planner)     echo "- bd-planner: plans with binary acceptance contracts; read-only on source.";;
    *) echo "- bd-${role}: (description not registered)";;
  esac
}

IFS=',' read -ra ROLE_LIST <<< "$ROLES"
SPECIALISTS_LIST=""
for role in "${ROLE_LIST[@]}"; do
  case "$role" in research|builder|reviewer|synthesizer|planner) ;;
    *) echo "invalid role: $role" >&2; exit 3;; esac
  line="$(specialists_block_for_role "$role")"
  if [[ -z "$SPECIALISTS_LIST" ]]; then
    SPECIALISTS_LIST="$line"
  else
    SPECIALISTS_LIST="${SPECIALISTS_LIST}"$'\n'"$line"
  fi
done

# Build the prompt-variables JSON. Use python to JSON-escape to avoid breaking
# on quotes / newlines in the topic or specialists block. Python is already a
# project dep (briefingdeck stack).
VARS_JSON="$(
  TOPIC="$TOPIC" \
  TENTACLE="$TENTACLE" \
  SPECIALISTS="$SPECIALISTS_LIST" \
  python3 -c '
import json, os
print(json.dumps({
    "topic":        os.environ["TOPIC"],
    "question":     os.environ["TOPIC"],
    "tentacleName": os.environ["TENTACLE"],
    "specialists":  os.environ["SPECIALISTS"],
}))
'
)"

# 3. Spawn coordinator
COORD_NAME="coord-$(date +%s)"
echo ">> spawning coordinator on tentacle=${TENTACLE} (template=${COORD_TEMPLATE})"
if [[ "$DRY_RUN" -eq 1 ]]; then
  COORD_ID="term-DRY-coord"
  echo "DRY: $OCT terminal create --tentacle-id '$TENTACLE' --name '$COORD_NAME' --prompt-template ${COORD_TEMPLATE} --prompt-variables '$VARS_JSON' --workspace-mode shared"
else
  COORD_ID=$($OCT terminal create --tentacle-id "$TENTACLE" --name "$COORD_NAME" \
    --prompt-template "$COORD_TEMPLATE" --prompt-variables "$VARS_JSON" \
    --workspace-mode shared | grep -oE 'term-[a-zA-Z0-9_-]+' | head -1)
fi
echo "coordinator: $COORD_ID"

# 4. Spawn one worker per role
WORKER_IDS=()
for role in "${ROLE_LIST[@]}"; do
  echo ">> spawning bd-$role worker"
  if [[ "$DRY_RUN" -eq 1 ]]; then
    WID="term-DRY-$role"
    echo "DRY: $OCT terminal create --tentacle-id '$TENTACLE' --parent-terminal-id '$COORD_ID' --prompt-template bd-$role --prompt-variables '$VARS_JSON' --workspace-mode worktree"
  else
    WID=$($OCT terminal create --tentacle-id "$TENTACLE" --parent-terminal-id "$COORD_ID" \
      --name "bd-$role-$(date +%s)" --prompt-template "bd-$role" \
      --prompt-variables "$VARS_JSON" --workspace-mode worktree \
      | grep -oE 'term-[a-zA-Z0-9_-]+' | head -1)
  fi
  WORKER_IDS+=("$role:$WID")
done

# 5. Vote-mode: print the channel-send commands the coord will issue. In
#    dry-run we ONLY print; we never execute the channel sends. This is what
#    makes --dry-run --vote safe to run without spawning live processes.
if [[ "$VOTE" -eq 1 ]]; then
  echo
  echo "=== vote fan-out plan ==="
  for w in "${WORKER_IDS[@]}"; do
    role="${w%%:*}"
    wid="${w##*:}"
    if [[ "$DRY_RUN" -eq 1 ]]; then
      printf "DRY: %s channel send %s %q --from %s\n" \
        "$OCT" "$wid" "$TOPIC" "$COORD_ID"
    else
      echo "(will run at vote time) $OCT channel send $wid \"...\" --from $COORD_ID"
    fi
  done
fi

# 6. Print summary
echo
echo "=== team spawned ==="
echo "tentacle:    $TENTACLE"
echo "topic:       $TOPIC"
echo "coordinator: $COORD_ID  (template=$COORD_TEMPLATE)"
for w in "${WORKER_IDS[@]}"; do echo "worker:      $w"; done
if [[ "$VOTE" -eq 1 ]]; then
  echo "mode:        vote (artifacts will land in ~/.octogent/projects/<id>/votes/)"
fi
if [[ -n "$CHART_PATH" ]]; then
  echo "chart:       $CHART_PATH (validated)"
fi
echo "dashboard:   http://localhost:${API_PORT}/"
