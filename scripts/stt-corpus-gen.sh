#!/bin/sh
# Regenerates the synthetic clips in test/fixtures/stt/ (issue #61). Real
# recordings, if any, are committed alongside and listed in expected.json by hand.
# Needs macOS `say` and ffmpeg. Every clip: 16 kHz mono s16 WAV with 1.5 s of
# trailing digital silence so the worker finalizes on a silence gap.
set -e
cd "$(dirname "$0")/../test/fixtures/stt"
tmp=$(mktemp -d)
norm() { # in out [volume]
  ffmpeg -loglevel error -y -i "$1" -af "volume=${3:-1},apad=pad_dur=1.5" -ar 16000 -ac 1 -c:a pcm_s16le "$2"
}
say -v Samantha -o "$tmp/a.aiff" "The quick brown fox jumps over the lazy dog."
norm "$tmp/a.aiff" speech_fox.wav
say -v Daniel -o "$tmp/b.aiff" "Let's meet at the fire pit after lunch and talk about the new map."
norm "$tmp/b.aiff" speech_firepit.wav
say -v Samantha -o "$tmp/c.aiff" "Okay."
norm "$tmp/c.aiff" speech_okay.wav
say -v Samantha -o "$tmp/d.aiff" "The meeting starts at three o'clock."
norm "$tmp/d.aiff" speech_quiet.wav 0.04
ffmpeg -loglevel error -y -i ../../../sounds/claude_intro.wav -af "apad=pad_dur=1.5" -ar 16000 -ac 1 -c:a pcm_s16le speech_claude_intro.wav
# must-be-empty clips
ffmpeg -loglevel error -y -f lavfi -i "anullsrc=r=16000:cl=mono" -t 3 -c:a pcm_s16le silence_3s.wav
ffmpeg -loglevel error -y -f lavfi -i "anoisesrc=r=16000:c=pink:a=0.05:d=4" -af "apad=pad_dur=1.5" -ac 1 -c:a pcm_s16le noise_low.wav
ffmpeg -loglevel error -y -f lavfi -i "anoisesrc=r=16000:c=brown:a=0.08:d=4" -af "apad=pad_dur=1.5" -ac 1 -c:a pcm_s16le noise_brown.wav
ffmpeg -loglevel error -y -f lavfi -i "sine=f=120:r=16000:d=4" -af "volume=0.05,apad=pad_dur=1.5" -ac 1 -c:a pcm_s16le hum_120hz.wav
# harder: weak/ambiguous audio that tends to provoke tiny's hallucinations
ffmpeg -loglevel error -y -f lavfi -i "anoisesrc=r=16000:c=white:a=0.02:d=5" -af "apad=pad_dur=1.5" -ac 1 -c:a pcm_s16le noise_white_hiss.wav
ffmpeg -loglevel error -y -f lavfi -i "anoisesrc=r=16000:c=pink:a=0.3:d=0.15" -af "adelay=800,apad=pad_dur=3" -ac 1 -c:a pcm_s16le noise_click.wav
ffmpeg -loglevel error -y -f lavfi -i "sine=f=440:r=16000:d=3" -af "volume=0.1,apad=pad_dur=1.5" -ac 1 -c:a pcm_s16le tone_440hz.wav
ffmpeg -loglevel error -y -i "$tmp/b.aiff" -f lavfi -i "anoisesrc=r=16000:c=pink:a=0.08:d=8" -filter_complex "[0:a]aresample=16000,volume=0.3[s];[1:a][s]amix=inputs=2:duration=longest:normalize=0,apad=pad_dur=1.5" -ac 1 -c:a pcm_s16le speech_in_noise.wav
ffmpeg -loglevel error -y -i "$tmp/b.aiff" -af "atrim=0:0.6,volume=0.5,apad=pad_dur=1.5" -ar 16000 -ac 1 -c:a pcm_s16le speech_fragment.wav
ffmpeg -loglevel error -y -i "$tmp/a.aiff" -af "volume=0.012,apad=pad_dur=1.5" -ar 16000 -ac 1 -c:a pcm_s16le speech_whisper.wav
rm -rf "$tmp"
ls -la
