---
description: Drive the WorkAdventure avatar — passthrough to the `wa` CLI
argument-hint: "<join|leave|status|to|follow|unfollow|quiet|resume|greet|speech-bubble|thought-bubble|clear-bubble|sound> …"
allowed-tools: Bash
---

Run `wa $ARGUMENTS` (falling back to `npx -y workadventurer wa $ARGUMENTS` if
`wa` is not on PATH) and report the result in one line. If `$ARGUMENTS` is
empty, run `wa status`.
