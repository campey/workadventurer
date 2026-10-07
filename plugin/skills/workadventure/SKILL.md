---
name: workadventure
description: Use when the user wants to do something with their WorkAdventure avatar / "in the room" / "in workadventure" — join or leave, see who's around, walk to or follow a player, greet someone, show a speech or thought bubble, or go sit somewhere quiet.
---

# Steering the WorkAdventure avatar

Drive it with the `wa` CLI (from the `workadventurer` npm package). Use `wa` if
it's on PATH, else `npx -y workadventurer wa`.

Start of a session: `wa status`; if it says "not joined", run `wa join --detach`
(there is no continuous follow — to get next to someone use `wa to <player>`).

| Command | Effect |
|---|---|
| `wa status [--json]` | position, area, visible players |
| `wa to <player>` | walk next to them |
| `wa quiet` | step away to the nearest empty area (stays put if already quiet) |
| `wa greet <player>` | walk over + "hi" speech bubble |
| `wa speech-bubble <text>` / `wa thought-bubble <text>` | text over the avatar |
| `wa clear-bubble` | dismiss whatever bubble is showing |
| `wa sound <name>` | play a clip into the proximity voice chat (`chime`, `blip`) — needs someone in the bubble |
| `wa goto <x> <y>` | walk to raw coordinates |
| `wa leave` | disconnect and stop |

Player names match case-insensitively as substrings.

Report back in a sentence or two. For a long multi-step session where the user
keeps giving directions, hand off to the `workadventure` subagent instead so it
holds the back-and-forth.
