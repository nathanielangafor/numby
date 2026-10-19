#!/usr/bin/env bash
# Transport-neutral dispatch state is owned by the connector, not hook wake prose.
set -euo pipefail
source "$HATCH_HOOK_RUNTIME"
: "${NUMBY_DIR:?Set NUMBY_DIR to the connector state directory}"
: "${NUMBY_BRIDGE:?Set NUMBY_BRIDGE to the installed numby-bridge.py}"
payload=$(python3 "$NUMBY_BRIDGE" dispatch --dir "$NUMBY_DIR")
if [[ $(printf '%s' "$payload" | jq '.items | length') -gt 0 ]]; then
  wake 'Numby work available: claim each item with worker-start before acting' "$payload"
elif [[ $(printf '%s' "$payload" | jq '.attention | length') -gt 0 ]]; then
  wake 'Numby needs attention: report only; do not replay work or bypass approval' "$payload"
else
  silent 'no dispatchable messages' '{}'
fi
