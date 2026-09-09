#!/usr/bin/env bash
# Drive the avatar into a WorkAdventure map-area meeting (`livekitRoomProperty`)
# and play a sound into it. Defaults to the "Lean Coffee Table 1" area of the
# lean-iterator campus room. See issues #10, #13, #17.
#
#   scripts/lean-coffee.sh [roomUrl] [x] [y]
#
# Leaves the daemon running afterwards so you can keep poking at it.
set -euo pipefail
cd "$(dirname "$0")/.."

ROOM="${1:-https://play.workadventu.re/@/levelup-npc/lean-iterator/campus}"
X="${2:-660}"
Y="${3:-2740}"

slug=$(node -e 'import("./src/map-nav.mjs").then(m=>process.stdout.write(m.roomSlug(process.argv[1])))' "$ROOM")
map="map/$slug/collision.json"
[ -f "$map" ] || { echo "· baking $map"; node scripts/build-collision.mjs "$ROOM"; }

echo "· restarting daemon on $ROOM"
pkill -f wa-daemon.mjs 2>/dev/null || true
sleep 1
rm -f ~/.workadventurer/daemon.json "${TMPDIR:-/tmp}/wa-daemon.json" ~/.workadventurer/daemon.log
WA_DEBUG=1 WA_ROOM="$ROOM" nohup node src/wa-daemon.mjs >~/.workadventurer/daemon.log 2>&1 &
echo "  daemon pid $!"

for _ in $(seq 1 20); do node bin/wa.mjs status >/dev/null 2>&1 && break; sleep 1; done

echo "· walking to ($X,$Y)"
node bin/wa.mjs goto "$X" "$Y" >/dev/null

for _ in $(seq 1 20); do
  sleep 2
  node bin/wa.mjs status --json 2>/dev/null | grep -q '"connected":true' && { echo "· voice connected"; break; }
  node bin/wa.mjs status >/dev/null 2>&1 || { echo "!! daemon unresponsive — see issue #17"; exit 1; }
done

echo
node bin/wa.mjs status
echo
grep -E "meeting area|joined space|webRtc|pc connected|area (enter|leave)" ~/.workadventurer/daemon.log || true

echo
echo "· playing chime";  node bin/wa.mjs sound chime || true
sleep 4
echo "· playing intro";  node bin/wa.mjs sound sounds/claude_intro.wav || true

cat <<EOF

daemon left running. next:
  node bin/wa.mjs sound <name|file>   # play another clip
  node bin/wa.mjs status              # where am I, who's in the meeting
  node bin/wa.mjs goto <x> <y>        # walk out (leaves the meeting)
  pkill -f wa-daemon.mjs              # stop
tail -f ~/.workadventurer/daemon.log  # watch the wire (WA_DEBUG on)
EOF
