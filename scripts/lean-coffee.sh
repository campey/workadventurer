#!/usr/bin/env bash
# Drive the avatar into a WorkAdventure map-area meeting (`livekitRoomProperty`)
# and play a sound into it. Defaults to the "Lean Coffee Table 1" area of the
# lean-iterator campus room. See issues #10, #13, #17.
#
#   scripts/lean-coffee.sh [roomUrl] [x] [y]
#
# Prints [+Ns] elapsed markers so you can see where the time goes. Leaves the
# daemon running afterwards so you can keep poking at it.
set -euo pipefail
cd "$(dirname "$0")/.."

ROOM="${1:-https://play.workadventu.re/@/levelup-npc/lean-iterator/campus}"
X="${2:-660}"
Y="${3:-2740}"

SECONDS=0
step() { printf '\n[+%3ss] %s\n' "$SECONDS" "$*"; }

slug=$(node -e 'import("./src/map-nav.mjs").then(m=>process.stdout.write(m.roomSlug(process.argv[1])))' "$ROOM")
map="map/$slug/collision.json"
if [ ! -f "$map" ]; then
  step "baking $map"
  node scripts/build-collision.mjs "$ROOM"
fi

step "restarting daemon on $ROOM"
pkill -f wa-daemon.mjs 2>/dev/null || true
sleep 1
rm -f ~/.workadventurer/daemon.json "${TMPDIR:-/tmp}/wa-daemon.json" ~/.workadventurer/daemon.log
WA_DEBUG=1 WA_ROOM="$ROOM" nohup node src/wa-daemon.mjs >~/.workadventurer/daemon.log 2>&1 &
echo "  daemon pid $!"

for _ in $(seq 1 20); do node bin/wa.mjs status >/dev/null 2>&1 && break; sleep 1; done
step "daemon up"

step "walking to ($X,$Y)  [wa goto blocks until arrival/timeout]"
t0=$SECONDS
node bin/wa.mjs goto "$X" "$Y" >/dev/null
echo "  goto took $((SECONDS - t0))s"

step "waiting for the area meeting to connect  [watching the daemon log]"
t0=$SECONDS
ok=
for _ in $(seq 1 40); do
  if grep -q "pc connected" ~/.workadventurer/daemon.log; then
    ok=1; echo "  connected after $((SECONDS - t0))s"; break
  fi
  grep -qE "unresponsive|uncaughtException" ~/.workadventurer/daemon.log && break
  sleep 1
done
[ -n "$ok" ] || echo "  !! no 'pc connected' after $((SECONDS - t0))s — meeting didn't connect (issue #17?)"

step "status"
node bin/wa.mjs status
echo
grep -E "meeting area|joined space|webRtc|pc connected|area (enter|leave)" ~/.workadventurer/daemon.log || true

step "playing chime";  node bin/wa.mjs sound chime || true
sleep 4
step "playing intro";  node bin/wa.mjs sound sounds/claude_intro.wav || true

step "done ($SECONDS s total). daemon left running."
cat <<EOF
  node bin/wa.mjs sound <name|file>   # play another clip
  node bin/wa.mjs status              # where am I, who's in the meeting
  node bin/wa.mjs goto <x> <y>        # walk out (leaves the meeting)
  pkill -f wa-daemon.mjs              # stop
tail -f ~/.workadventurer/daemon.log  # watch the wire (WA_DEBUG on)
EOF
