#!/bin/bash
# usage: run.sh <tag> <model>
export NODE_USE_ENV_PROXY=1; export TMPDIR=/private/tmp/claude/t
S="$(dirname "$0")"; ROOT="$1"; TAG="$2"; MODEL="$3"
cd "$ROOT"
shift 3; for c in "$@"; do
  W=$S/runs/$TAG-$c; git -C $S/ofetch worktree add -q -f $W $c 2>/dev/null
  s=$(python3 -c 'import time;print(time.time())')
  OPENROUTER_MODEL=$MODEL node --import tsx tools/report.ts --target $W --base ${c}^ --head $c --generate-context --report $S/runs/$TAG-$c.md > $S/runs/$TAG-$c.log 2>&1
  rc=$?
  e=$(python3 -c 'import time;print(time.time())')
  echo "$c rc=$rc wall=$(python3 -c "print(round($e-$s,1))")" >> $S/runs/$TAG.times
done
