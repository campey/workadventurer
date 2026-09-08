#!/usr/bin/env sh
# Thin wrapper the plugin hooks call. Resolves the `wa` CLI, and for the
# --if-running hook path it exits instantly when no daemon is advertised so a
# normal (no presence) session pays nothing.

case " $* " in
  *" --if-running "*)
    [ -f "${TMPDIR:-/tmp}/wa-daemon.json" ] || [ -f "$HOME/.workadventurer/daemon.json" ] || exit 0
    ;;
esac

# 1. explicit override
if [ -n "$WA_CLI" ]; then exec $WA_CLI "$@"; fi
# 2. installed on PATH (npm i -g workadventurer, or npm link)
if command -v wa >/dev/null 2>&1; then exec wa "$@"; fi
# 3. running the plugin straight from a checkout of the repo
if [ -n "$CLAUDE_PLUGIN_ROOT" ] && [ -f "$CLAUDE_PLUGIN_ROOT/../bin/wa.mjs" ]; then
  exec node "$CLAUDE_PLUGIN_ROOT/../bin/wa.mjs" "$@"
fi
# 4. zero-install from npm
exec npx -y workadventurer wa "$@"
