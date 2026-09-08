# Sound credits

| File | Source | License |
|---|---|---|
| `chime.ogg` | "Film Special Effects - Chime Alert Demo" by Olivia Parker — <https://pixabay.com/sound-effects/film-special-effects-chime-alert-demo-309545/> | [Pixabay Content License](https://pixabay.com/service/license-summary/) (free to use, attribution appreciated) |
| `blip.ogg` | generated with ffmpeg (`sine` + fade) | — |
| `claude_intro.wav` | synthesized speech — see below | [Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0) (model) |

Ogg clips are transcoded to Opus (48 kHz stereo, 20 ms frames) for direct RTP
publishing; source files for those are not stored in the repo.

## `claude_intro.wav`

Voice synthesized with **Sesame CSM-1B** (Conversational Speech Model,
[`sesame/csm-1b`](https://huggingface.co/sesame/csm-1b), Apache-2.0), run locally
on an Apple M2 via the **csm-mlx** MLX port
(<https://github.com/senstella/csm-mlx>) using the
[`senstella/csm-1b-mlx`](https://huggingface.co/senstella/csm-1b-mlx) weights.

Generated from a text prompt — no voice cloning, no reference audio (speaker 0,
temp 0.7, top-k 40). Output loudness-normalized to −16 LUFS with FFmpeg. **No
human voice was recorded or cloned.**

Kept as the raw 24 kHz mono WAV that CSM emits; `wa sound` transcodes it to Opus
on playback.
