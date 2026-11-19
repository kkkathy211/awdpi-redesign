#!/usr/bin/env bash
# Records progress for the editor's status page: status.sh <state> [extra JSON]
# Merges into s3://$BUCKET/status/$ID.json, which the internal form shows. Used by .github/workflows/wechat-import.yml.
set -euo pipefail
key="s3://$BUCKET/status/$ID.json"
extra=${2:-'{}'}
current=$(aws s3 cp "$key" - 2>/dev/null || echo '{}')
jq -c --arg state "$1" --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --arg run "${RUN_URL:-}" --argjson extra "$extra" \
  '. + $extra + {state: $state, at: $at, run: $run}' <<<"$current" |
  aws s3 cp - "$key" --content-type application/json --only-show-errors
