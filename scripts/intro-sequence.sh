#!/usr/bin/env bash
# Play a scripted intro: walk to a player (into their meeting area if they're in
# one), join the meeting, then for each clip play the wav + stream its transcript
# to the terminal, advancing one clip per thumbs-up emote from the player.
#
#   scripts/intro-sequence.sh [player] [scriptJson]
#
# Assumes a daemon is already joined to the right room (WA_ROOM).
set -euo pipefail
cd "$(dirname "$0")/.."

PLAYER="${1:-:David}"
SCRIPT="${2:-/Users/campey/Code/huggingsesame/claude_pregen_script.json}"
LOG=~/.workadventurer/daemon.log

# Cue emotes (WA sends the literal emoji): 👍 next · 👏 jump to outro ·
# ❤️ jump to the "purpose" clip (followup_5, index 6).
CUES='👍,👏,❤️'
JUMP_HEART_TO=6

node bin/wa.mjs status >/dev/null 2>&1 || { echo "no daemon — start one on the target room first"; exit 1; }
[ -f "$SCRIPT" ] || { echo "no script at $SCRIPT"; exit 1; }

echo "· walking to $PLAYER"
node bin/wa.mjs to "$PLAYER" >/dev/null
connected=
for _ in $(seq 1 40); do
  grep -q "pc connected" "$LOG" && { connected=1; echo "· meeting connected"; break; }
  grep -qE "unresponsive|uncaughtException" "$LOG" && { echo "!! daemon wedged (issue #17)"; exit 1; }
  sleep 1
done
[ -n "$connected" ] || { echo "!! meeting never connected — is $PLAYER in a livekitRoomProperty area?"; exit 1; }

DIR=$(node -e 'console.log(require(process.argv[1]).dir)' "$SCRIPT")
TOTAL=$(node -e 'console.log(String(require(process.argv[1]).clips.length))' "$SCRIPT")

i=0
while [ "$i" -lt "$TOTAL" ]; do
  read -r FILE DUR ROLE < <(node -e '
    const c = require(process.argv[1]).clips[Number(process.argv[2])];
    console.log([c.file, c.duration_s, c.role].join(" "));
  ' "$SCRIPT" "$i")
  TEXT=$(node -e 'console.log(require(process.argv[1]).clips[Number(process.argv[2])].text)' "$SCRIPT" "$i")

  printf '\n\033[2m[%d/%d %s]\033[0m ' "$((i + 1))" "$TOTAL" "$ROLE"
  node bin/wa.mjs sound "$DIR/$FILE" >/dev/null
  node scripts/typewriter.mjs "$TEXT" "$DUR"

  [ "$i" -ge "$((TOTAL - 1))" ] && break   # that was the outro

  printf '\033[2m   … 👍 next · 👏 skip to outro · ❤️ jump to “why”\033[0m\n'
  got=$( (node bin/wa.mjs wait-emote "$PLAYER" --emote "$CUES" --timeout 900000 --json 2>/dev/null || true) \
        | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).emote||"")}catch{console.log("")}})')
  case "$got" in
    *👏*) i=$((TOTAL - 1)) ;;
    *❤*)  i=$JUMP_HEART_TO ;;
    "")   echo "!! no cue — stopping"; exit 1 ;;
    *)    i=$((i + 1)) ;;
  esac
done

echo
echo "· done"
