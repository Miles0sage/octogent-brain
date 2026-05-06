#!/usr/bin/env bash
# spawn-team.sh — spawn a coordinator + N specialized BriefingDeck role agents
# under one octogent tentacle. See ~/.claude/skills/briefingdeck-spawn-team/.
set -euo pipefail

OCTOGENT_DIR="${OCTOGENT_DIR:-/root/octogent}"
API_PORT="${OCTOGENT_API_PORT:-8788}"
TOPIC=""; TENTACLE=""; ROLES="research,builder,reviewer"; DRY_RUN=0

usage() { cat >&2 <<EOF
Usage: $0 --topic "<topic>" --tentacle <name> [--roles research,builder,reviewer] [--dry-run]
Valid roles: research builder reviewer synthesizer planner
EOF
exit 1; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --topic) TOPIC="$2"; shift 2;;
    --tentacle) TENTACLE="$2"; shift 2;;
    --roles) ROLES="$2"; shift 2;;
    --dry-run) DRY_RUN=1; shift;;
    -h|--help) usage;;
    *) echo "unknown arg: $1" >&2; usage;;
  esac
done

[[ -z "$TOPIC" || -z "$TENTACLE" ]] && usage

# 1. Confirm octogent is up (skip in dry-run)
if [[ "$DRY_RUN" -eq 0 ]]; then
  curl -fsS "http://localhost:${API_PORT}/" >/dev/null \
    || { echo "octogent not reachable on :${API_PORT}" >&2; exit 2; }
fi

OCT="node ${OCTOGENT_DIR}/bin/octogent"
VARS_JSON=$(printf '{"topic":"%s","tentacleName":"%s"}' "$TOPIC" "$TENTACLE")

# 2. Spawn coordinator (uses upstream swarm-parent template)
COORD_NAME="coord-$(date +%s)"
echo ">> spawning coordinator on tentacle=${TENTACLE}"
if [[ "$DRY_RUN" -eq 1 ]]; then
  COORD_ID="term-DRY-coord"
  echo "DRY: $OCT terminal create --tentacle-id '$TENTACLE' --name '$COORD_NAME' --prompt-template swarm-parent --prompt-variables '$VARS_JSON' --workspace-mode shared"
else
  COORD_ID=$($OCT terminal create --tentacle-id "$TENTACLE" --name "$COORD_NAME" \
    --prompt-template swarm-parent --prompt-variables "$VARS_JSON" \
    --workspace-mode shared | grep -oE 'term-[a-zA-Z0-9_-]+' | head -1)
fi
echo "coordinator: $COORD_ID"

# 3. Spawn one worker per role
IFS=',' read -ra ROLE_LIST <<< "$ROLES"
WORKER_IDS=()
for role in "${ROLE_LIST[@]}"; do
  case "$role" in research|builder|reviewer|synthesizer|planner) ;;
    *) echo "invalid role: $role" >&2; exit 3;; esac
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

# 4. Print summary
echo
echo "=== team spawned ==="
echo "tentacle:    $TENTACLE"
echo "topic:       $TOPIC"
echo "coordinator: $COORD_ID"
for w in "${WORKER_IDS[@]}"; do echo "worker:      $w"; done
echo "dashboard:   http://localhost:${API_PORT}/"
