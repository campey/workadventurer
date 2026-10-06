#!/bin/sh
# Runs scripts/stt-eval.mjs once per worker config, in parallel (each process gets its
# own per-pid worker socket), writing <outdir>/<name>.txt and .json (issue #61).
#
#   scripts/stt-eval-matrix.sh <outdir> <repeat> name1='ENV=1 ENV2=x' name2='...' ...
#
# An empty value (name='') is the baseline.
set -e
out=$1; repeat=$2; shift 2
mkdir -p "$out"
root=$(cd "$(dirname "$0")/.." && pwd)
for spec in "$@"; do
  name=${spec%%=*}; envs=${spec#*=}
  ( env $envs \
      node "$root/scripts/stt-eval.mjs" --repeat "$repeat" --json "$out/$name.json" > "$out/$name.txt" 2>&1 || true ) &
done
wait
for f in "$out"/*.txt; do echo "== $(basename "$f" .txt): $(grep '^mean WER' "$f")"; done
