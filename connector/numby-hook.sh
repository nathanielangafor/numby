#!/usr/bin/env bash
# Muse hook adapter: registration cadence belongs to the Muse runtime.
set -euo pipefail
source "$HATCH_HOOK_RUNTIME"
: "${NUMBY_DIR:?Set NUMBY_DIR to the connector state directory}"
payload=$(python3 - "$NUMBY_DIR" <<'PY'
import json,pathlib,sys
items=[]
for p in pathlib.Path(sys.argv[1]).glob('*.json'):
 if len(p.stem)!=64 or any(c not in '0123456789abcdef' for c in p.stem):continue
 try:
  v=json.loads(p.read_text())
  if all(k in v for k in ('id','lease','conversation')):
   items.append({k:v[k] for k in ('id','lease','kind','text','emoji','targetId','replyTo','conversation') if k in v})
 except (ValueError,OSError):continue
print(json.dumps({'items':items}))
PY
)
previous=$(hook_state_get 2>/dev/null | jq -c '.seen // []' 2>/dev/null) || previous='[]'
# A retry receives a new lease. Wake once per (message id, lease).
next=$(printf '%s' "$payload" | jq -c '[.items[]|[.id,.lease]]')
if [[ "$next" == '[]' || "$previous" == "$next" ]]; then silent 'no new messages' '{}'; fi
hook_state_set "$(jq -cn --argjson seen "$next" '{seen: $seen}')"
wake 'Numby message received' "$payload"
