#!/bin/bash
# Cloud sessions only: install what `npm test` needs (node deps + the python
# packages stt_worker.py's unit tests import). Idempotent.
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

# Async: the session starts straight away while the installs run in the background.
echo '{"async": true, "asyncTimeout": 300000}'

cd "${CLAUDE_PROJECT_DIR:-.}"
npm install --no-audit --no-fund
python3 -m pip install -q --disable-pip-version-check tqdm numpy
