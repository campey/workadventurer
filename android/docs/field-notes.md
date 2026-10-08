# Android field notes

What we learn building the Android client, per gate. The design is a hypothesis;
anything here that contradicts it means the spec gets revised first.

## Call logs (issue #98)

Logcat keeps about an hour, so every call also writes its own file: one per join→leave (a drop and reconnect stays in the
same file), in the app's private `files/logs/`, named `<date>T<time>_<room>.log` (staging rooms start `staging-`). The
newest 20 files / 20 MB are kept; one file stops at 5 MB. Each starts with `#` header lines (app, phone, room, server), then
`HH:mm:ss.SSS TAG message` lines: `WaSession` (state, mute and who tapped it), `WaConn` (joins, spaces, mic announcements),
`WaVoice` (offers, `audio lines in offer`, 5 s audio stats), `WaDevice` (audio devices, screen, network, permissions),
`WaService`. No uuids, emails, SDP or device names.

- Get them off the phone: **Share logs** in the app (share sheet, last 5 files), or
  `adb shell run-as app.workadventurer cat files/logs/<file>` (debug builds).
- Read them: `node android/tools/call-log-summary.mjs <file>...` prints length, drops, per-peer time to first audio, stalls
  (mic on but nothing sent) and **RED MIC?** suspects (the phone announced mic on and sent nothing for 10 s+; says whether the
  last offer had an audio line, see #97), plus mute taps, device events and errors.
- Record a call in `docs/real-world-test-log.md` or `docs/experimental-test-log.md` and name its log file there.

## Toolchain

- **JDK 17 (Temurin) from a tarball in `~/.jdks`, not the brew cask.** The cask's
  `.pkg` installer needs `sudo` with a TTY, which `!` commands in Claude Code
  don't have. Android Studio's bundled JBR is JDK 25, too new for Gradle 8.10 /
  Kotlin 2.0 / AGP 8.7. Run Gradle with `JAVA_HOME` pointed at the 17 JDK.
- The Gradle wrapper was generated from a one-off Gradle 8.10.2 download (avoids
  `brew install gradle`, which pulls a from-source `openjdk` on macOS 14).

## Protocol and behaviour reference (what we know, and how we know it)

One place for the facts that took live testing to learn. Evidence tags: **[live]** measured on the phone against browsers,
**[code]** read from our code or the server source, **[guess]** a hypothesis that fits the evidence but isn't confirmed. The
per-gate sections below have the measurements; this section is the summary to start from. The CLI's equivalents are in
`docs/field-notes.md` (`#10` the red mic) and `docs/livekit.md`.

### Spaces and bubbles
- **The server drives bubble membership** [code, live]: it sends `joinSpaceRequestMessage{spaceName, propertiesToSync}`; we
  answer with a `JoinSpaceQuery{spaceName, filterType ALL_USERS, propertiesToSync}` (default `cameraState`, `microphoneState`,
  `screenSharingState`), the answer carries our `spaceUserId`, and then we send `addSpaceFilterMessage` ("watch"). Without the
  watch the server never sets up peer connections for us. `leaveSpaceRequestMessage` makes us leave.
- Joins and leaves are serialised by one mutex and started in arrival order, so a leave can never overtake a join (a join that
  lands after its leave would leave the phone speaking into a bubble it left). [code, review finding]
- **Bubble space names** are the room URL plus `#<group id>#<timestamp>`, not fixed [live]. **Map meeting areas** are different:
  the client joins them itself, with a name it computes: `slugify(shortHash(roomUrl) + "-" + (the room name if non-blank, else
  the area's property id))`, using the room URL exactly as typed (a trailing slash or `#entry` hashes differently and lands in an
  empty space). The area carries `livekitRoomProperty`. We join after standing in it 1.5 s and leave 2.5 s after walking out,
  so walking through one joins nothing. [code, ported from the front end; live: joined and held a 1-hour call in one]
- A new connection id for a peer we already have a link to **replaces** the old link (the server restarts connections with a new
  id). Keyed on (space, peer). [code]

### Roles and signalling
- **Who offers** [live, code]: the server tells the user who was already watching the space to offer (`initiator=true`); the
  phone nearly always is that user, so the phone must be able to offer. If nobody offers, the browser times out after ~20 s,
  sends `meetingConnectionRestartMessage` and the roles swap. See "G3 M2" for the measurements (21 s vs 1.25 s).
- Signals are simple-peer JSON [live]: `{type: offer|answer, sdp}` with the **full SDP and its ICE candidates inside** (no
  trickle), `{type: candidate}`, and `{type: "renegotiate", renegotiate: true}`. The initiator creates the `simplepeer` data
  channel (a browser reports "connected" only once it opens). `transceiverRequest` also arrives; we ignore it and don't know its
  shape. [live]
- A browser offer always has an `m=video` section. We keep the line (answers must match the offer's order) and set it
  **inactive**, so a peer with a camera never streams video to a backgrounded phone. [code, live]

### Microphone state and mute
- **Mic state is a claim; audio is separate.** We tell the space `UpdateSpaceUserMessage{spaceName, user{spaceUserId,
  microphoneState}, updateMask: ["microphoneState"]}`. A browser shows a **red mic** when the claim says on but no audio
  arrives. [live; CLI `#10` for the first form of it]
- We announce on a schedule, not once, because a single announcement races the server registering us: while the mic is on, at
  join +0 s, +1 s and +3 s, again when the space's user list (`initSpaceUsers`) arrives, and at every unmute; muting announces
  **off at once** and cancels pending "on" announcements. Nothing is announced for a space we aren't in. [code]
- **Mute on Android** [code, live]: one shared microphone track for every link. Muting calls `setMicrophoneMute`, which
  zero-fills the capture buffer, so silence RTP keeps flowing and the browser's indicator stays correct. The app **starts
  muted on every join**, the choice survives a reconnect, Leave resets it, and the notification's Mute/Unmute action does the
  same thing as the button (the call log records which one was used).
- **Capture keeps running while muted** (Android's mic indicator stays lit; some battery). Deliberate: stopping capture would
  end the silent stream and bring the red mic back. [code; indicator behaviour not measured on a device]
- **A browser that joins muted** has no audio line in its first offer, and changes that when its user unmutes. Phone hearing
  it: the browser must renegotiate (as the answerer it sends `renegotiate` and we, the offerer, must re-offer; as the offerer it
  re-offers itself and we must answer a second offer on the live link). Both were bugs found live. [live]
- **The reverse direction is not understood** [guess]: with the browser joined muted and the phone answering, the phone's mic
  was announced on while the link had no audio line to send on (`sent=0`, `dir=` empty), and the browser showed a red mic until
  its own re-offer ~20 s later. Seen once on staging, not reproduced: issue #97. The call log's `audio lines in offer: N` line
  exists to confirm or kill this.

### libwebrtc on Android
- The process aborts without `ACCESS_NETWORK_STATE`; the engine needs ~1.5 s after creation to learn the network (create it
  at join, and don't trust an instant "gathering complete" with zero candidates); video codecs must be registered or a real
  browser offer aborts the process; ICE `COMPLETE` can arrive before the first candidate, so wait for one candidate then
  let gathering settle. [live; details in the spike and M2 sections]
- **Only the mesh coroutine may touch a `PeerConnection`.** `getTransceivers()` disposes the wrappers it returned last time, so a
  second thread reading them (the stats loop did) can make a negotiation fail or touch a disposed object. Teardown happens on
  that same coroutine, after any negotiation returns. Attach the shared mic with `setTrack(track, false)`: `true` would dispose
  the track the other links share. [code, review finding]
- The audio mode is `MODE_IN_COMMUNICATION` for the whole connection and restored afterwards. [code]

### Maps (the campus map)
- **Spawn**: the `.wam` start area if there is one; otherwise a tile of the map's Tiled `start` layer; the old fixed corner put
  the avatar where it saw nobody. [live, #90]
- **Furniture collision**: each entity in the `.wam` has a prefab id (`<collection>:<name>:<color>:<direction>`); the `.wam`
  lists the collection files (`entityCollections`, entries of `type: "file"` have a public URL); each entry has a
  `collisionGrid` of 0/1 rows (32 px cells from the entity's top-left; origin cell `floor((x+16)/32)`) and **an entry without
  one is not solid**. Blocking all furniture as 3×3 squares split the campus map into 20 islands, so walks had no route and fell
  back to straight lines through walls. If no collection loads we fall back to the old 3×3 approximation. [live, #90; the CLI's
  baker still has the old behaviour: #92]

### Server versions
- Prod `play.workadventu.re` was v1.34.0 from 2026-10-05; its API hash is `23c8eb8c` (older hashes get a "new version" error
  screen). Staging is rolling `master` (seen at `master@6ae415d` on 2026-10-07) and its hash is **also `23c8eb8c`**. [live]
- **Staging has its own pusher and its own character catalogue** (`pusher.staging.workadventu.re`; a prod woka id is refused
  with "invalid character texture"); the app chooses both from the room's host (`RoomConfig.forRoom`). Joining the staging village worked
  first time, including audio. [live]

### Observed on real calls (not protocol, but what to keep working)
- Speaking with the **screen locked** works; **pressing the power button does not hang up** (many call apps do; this is a
  requirement, issue #85). Changing the audio route from handset to a plugged-in wired headset mid-call did not disturb the call.
  An hour-long call in a meeting area, and a stable call on staging while driving. See `docs/real-world-test-log.md`. [live]
- Unexplained: a ~10 s network drop on the phone during M3 testing (cause unknown; drop reasons are logged since). [live]
- Not yet checked live: mute from the notification, mute surviving a reconnect, LiveKit escalation (G4: the app ignores
  `livekitInvitationMessage`).

## G3 — voice: library spike, step 1 (2026-10-06)

Question: does LiveKit's libwebrtc build run on the phone and produce the audio offer a WorkAdventure browser peer needs?
Throwaway probe: `voice/src/androidTest/.../WebRtcSpikeTest.kt`, run on the S25 Ultra with
`./gradlew :voice:connectedDebugAndroidTest`. Measured on the phone, not unit-tested.

- **Which artifact.** `livekit-android` 2.29.0 depends on `io.github.webrtc-sdk:android-prefixed:144.7559.14`, the
  *prefixed* build (classes are `livekit.org.webrtc.*`, not `org.webrtc.*`). The mesh uses that exact artifact and
  version directly, so G4's `livekit-android` shares one native stack. (The plain `io.github.webrtc-sdk:android` artifact
  is a different build; mixing the two would put two copies of libwebrtc in the app.)
- **It runs.** `PeerConnectionFactory` initialises, an audio track plus a `simplepeer` data channel produce an offer with
  `m=audio` (Opus 111, red, G722, PCMU/A, telephone-event), `m=application` (SCTP data channel), DTLS `actpass`.
- **Needs `ACCESS_NETWORK_STATE`, or the whole process aborts.** libwebrtc's network monitor calls
  `ConnectivityManager.getActiveNetworkInfo`; without the permission it throws and a native `CHECK` in `jvm.cc` kills the
  process (SIGABRT on `network_thread`, nothing catchable). Declared in `voice/src/main/AndroidManifest.xml` along with
  INTERNET, MODIFY_AUDIO_SETTINGS, RECORD_AUDIO.
- **Gathering started right after the factory is created finds no network.** Offer created immediately: 0 candidates and
  "gathering complete" within milliseconds. After a 1.5 s pause: 2 host + 2 srflx candidates, all in the offer. libwebrtc
  learns the network list asynchronously. Production must create the engine early (at join, not at the first bubble) and
  must not trust a very fast "complete" with zero candidates, the same guard the Node client has (`candidateCount === 0`
  tears down).
- **Not yet tried:** answering a real browser offer (with its `m=video`), being offered to, the microphone and echo
  cancellation, the WorkAdventure space/signalling path (the Android client has no space handling yet).

## G3 M1 live check, space join (2026-10-06)

Phone joined as `g3-voice`, the user (David, in a browser) walked next to it, then away. From the phone's own log:
- 17 s after joining, within a second of David arriving: `entered bubble 1637`, `joined space <room url>#1637#<timestamp>`,
  `webRtcStart conn=<uuid> initiator=true`. No `joinSpace ... failed`.
- The space name is the room URL plus the bubble's group id and a timestamp, not a fixed name.
- **Who gets `initiator=true`** (superseded by M2 below: this first reading was wrong). When a browser avatar walks up to a
  phone that is already standing there, the phone is told to send the offer, as expected. We then assumed that answering
  would only happen when the phone walks into someone else's bubble; M2 showed the phone is told to offer *in both cases*,
  because "existing member" means who started watching the space first, not who was standing there first.
- Two more `webRtcStart` arrived 20 s and 41 s later with `initiator=false` and fresh connection ids (the server's retry
  after nothing answered the first, since this build only logs and ignores them).
- Walking away: `left space`, `left bubble`, then `webRtcDisconnect` from the peer, in that order.

## G3 M3 live check, speaking, mute, meeting areas (2026-10-06 / 07)

Measured live against browser peers on the S25 Ultra unless marked.

- **Two-way audio works, both roles.** Phone as answerer and as offerer. Offerer role matters: connect took 1.25 s as offerer
  vs ~21 s waiting for the browser's own timeout and the server's role swap.
- **No red mic on prod in these checks.** On a link that has an audio line, the mic track is shared and always sending; mute
  is `setMicrophoneMute`, which zero-fills the capture buffer, so RTP keeps flowing (silence) and the browser's indicator
  stays correct. Mute/unmute shows properly in the browser. **Exception seen later (2026-10-07, staging, once):** a link with
  no audio line to send on showed a red mic until the browser re-offered; see the reference section and #97.
- **Browser that joins muted** needs a second negotiation when its user unmutes. As answerer it sends `{type:"renegotiate"}`
  and waits for the initiator to offer again: we must re-offer (offerer only). As offerer it re-offers itself and we must answer
  a second offer on the live connection (`attachMic` and answering are repeatable). Both were bugs found live and are pinned by
  on-device tests (`BrowserLikeOfferTest`).
- **Mic-in-use indicator while muted (decision, not measured on device):** capture keeps running while muted
  (`setMicrophoneMute` does not stop `AudioRecord`), so Android's mic indicator stays lit and capture costs some battery while
  the UI says "muted". Stopping capture would end the zero-RTP stream and bring back the red mic. Kept, deliberately.
- **Meeting areas** join after a 1.5 s dwell and leave after 2.5 s outside; space name is `slugify(shortHash(roomUrl)-name)`,
  from the room URL exactly as typed (a trailing slash or `#entry` hashes differently and lands in an empty space).
- **Not handled yet:** `livekitInvitationMessage` (G4) — in a large area meeting the server moves everyone to LiveKit and the
  phone would sit in the space announcing mic-on with no media; `transceiverRequest`; the same browser reachable through both an
  area space and a bubble (two PeerConnections, mic sent twice) — supersede is keyed on (space, peer).
- **Review finding fixed:** libwebrtc objects were read by the 5 s stats loop on another thread while the mesh coroutine
  negotiated or disposed them (`getTransceivers()` disposes the previous wrappers). Stats now run on the mesh coroutine.
  Rule: only the mesh coroutine touches a `PeerConnection`.
- **Not yet checked live:** speaking with the screen locked, mute from the notification, mute surviving a reconnect.

## G3 M2 live check, hearing a browser peer (2026-10-06)

The phone (`g3-voice`) walked to the user's browser avatar (David, mic on); the user heard David's voice come out of the
phone, then with the screen locked, then across four bubble leave/enter rounds. From the phone's own log:
- **It works against a real browser.** `webRtcStart … initiator=false`, then `answered` 0.3-0.5 s later, audio plays,
  also with the screen locked (`mWakefulness=Dozing`), no crash, no `AndroidRuntime`/native abort.
- **The server tells the PHONE to initiate first, in both directions.** Each of the 4 rounds began with `initiator=true`
  (ignored: the offerer role is M4), and about **21 s later** (21.0, 20.7, 21.3, 21.0 s) a second `webRtcStart` arrived
  with a new connection id and `initiator=false`, which we answered. In the first M1 run the phone was the one stood still
  and got `true` first as well; here the phone walked into the browser's bubble and still got `true` first. So the earlier
  reading "existing members get initiator=true, the newcomer answers" does not predict who is told to offer.
  **Mechanism, from the server source** (`back/src/Model/Strategies/WebRTCCommunicationStrategy.ts`, v1.34.0):
  `establishConnection(user1, user2)` sends `initiator=true` to the user who was already watching the space and
  `initiator=false` to the one who just started watching. The phone joins and watches within milliseconds of the bubble
  forming, a browser takes longer, so the phone is nearly always the "existing" member and is told to offer. We ignored that,
  so the browser waited for an offer that never came, hit its own connection timeout (~20 s), and sent
  `meetingConnectionRestartMessage`; `handleMeetingConnectionRestartMessage` then re-sends both starts with the roles swapped,
  which is the second `webRtcStart` (`initiator=false`) we answered.
  Result: **audio started about 21 s after entering a bubble.** M4 (the phone as offerer) removes that wait; it is needed
  for usable voice, not optional.
- **The offerer role fixes the wait (Task 11, measured).** With the phone offering when told `initiator=true`: start at
  23:30:35.189, `offered` at 23:30:36.435 (1.25 s, mostly the engine's 1.5 s warm-up and ICE gathering), and the user
  reported the audio connecting "much quicker", against about 21 s before. The offerer creates the `simplepeer` data channel
  and a receive-only audio transceiver (no microphone until M3). An on-device loopback test (our offerer and our answerer
  negotiating in one process) reaches "connected" 3 runs out of 3. One browser signal right after the offer was logged as
  "unparseable or unsupported" and ignored (`renegotiate` (a browser that joined muted: it needs a re-offer from us, see the M3 section) or `transceiverRequest` (still unhandled)); worth logging its
  `type` next time.
- Clean teardown every round: `left space`, `left bubble`, then the peer's `webRtcDisconnect`. App memory did not grow
  across the rounds (PSS about 151 MB before, about 96 MB after).
- libwebrtc build findings (see the unit and instrumented tests): the factory needs video codecs registered (software
  encoder/decoder factories) or it aborts the process natively on a real browser offer ("`front()` called on an empty
  vector"); with them registered the answer includes the video section as `recvonly` rather than rejecting it. And ICE
  gathering `COMPLETE` can arrive before the first candidate is delivered (2 of 3 answers had no candidates), so
  `WebRtcPeerLink` waits for a first candidate, then up to 1 s for the rest.

## G2 — movement (2026-10-05 / 06)

**Verdict: walk-to and invitations (both directions, including locating a player outside the viewport) work on a real
phone against prod, including with the screen locked; the live runs changed several things (below, and "G2 live checks
on the real phone").**

Measured:
- **Runtime collision builder matches the Node bake exactly.** `wa-cli collision --baked …` rebuilds each map from the
  live `.wam` + `.tmj`: afrolabs 913 = 913 blocked tiles, lean-iterator 2961 = 2961, no differences either way.
  wa-village: Kotlin 3390 vs the committed bake's 3426; a *fresh* Node bake today also gives 3390 and then matches
  Kotlin exactly, so the committed `map/tcm/…/collision.json` (2026-09-10) is simply stale (36 tiles).
- **Kotlin A\* equals Node's, path for path** on 74 generated cases (exact equality), including the 6 unreachable ones.
- **Grid load is off the critical path:** join → `Connected` in about 4 s; the `.tmj` (1.5 MB) takes ~4.4 s more on a
  cold first run and ~0.2 s once cached on disk (logcat, real phone).
- **One continuous 32-minute connection on the phone** (09:24:31 → 09:56:56, foreground service up, screen on and then
  off) with **no reconnect or disconnect event** in the new logcat output (`adb logcat -s WaConn:I WaSession:I`).
  This answers the open G1 question "did a silent reconnect happen?" for that run, and extends G1's 6½-minute soak.
- Mac-side CLI run (follow, since removed) tracked a moving browser avatar across ~2,000 px; all 18 sampled positions
  were on free tiles.

Reported by the user (not measured): walk-to "seems to work really well" on the phone.

Findings that changed the build:
- **"Follow" was the wrong feature and was removed.** WorkAdventure's follow is a mutually negotiated request made once
  in a bubble (`FollowRequest` / `FollowConfirmation` / `FollowAbort`), not a client loop that keeps walking toward a
  player. "Walk to" is the only thing you can do to a player at a distance. The Node CLI's `wa follow` has the same
  mislabelling. Real follow is issue #76; the Android UI redesign (users panel, a screen per user) is #77.
- **Walk-to didn't always get close enough to bubble up.** WorkAdventure v1.34.0 defaults (read from
  `back/src/Enum/EnvironmentVariableValidator.ts`): `MINIMUM_DISTANCE = 64` px to form a bubble,
  `GROUP_RADIUS = 48` px to join one. We stopped 40–88 px away. Now: stand 40 px in front, stop within 8 px (ends
  32–48 px away), re-plan every 500 ms (it was 2 s, so a player who walked away was chased from where they were up to
  2 s earlier). A failing test reproduced it first (stopped 76 px away). The numbers are the documented defaults, not
  measured on prod.
- **"Couldn't join: …" vanished within 6 ms** (phone log: `Failed` → `Disconnected` 6 ms apart): the service stops
  itself after a failed join, and its `onDestroy` then reset the session. Fixed with a tested rule
  (`shouldLeaveWhenServiceStops`).
- **The player list only shows nearby players.** The server streams only players inside the viewport around us
  (about ±1,920 × ±1,080 px); after walking ~1,600 px away the list dropped from 3 players to 0. For "who's around"
  that's right, for "who's in the room" it isn't. The protocol has `AskPosition{userIdentifier, playUri, LOCATE|MOVE}`
  → `LocatePosition` to find a player outside the viewport; the Android client now uses it when accepting an invite from
  someone we can't see (verified on the wire since: see the live checks below). Folded into #77.
- **Smoothed paths can graze a wall corner** (as in the Node client): the smoothing guarantees line-of-sight between
  tile *centres*, not geometric clearance. Measured at 1.2 px inside a wall tile in the unit geometry; the test now
  asserts "never more than 12 px into a wall". Cosmetic: movement is client-authoritative.
- **A first-attempt transport failure is final** (reviewer finding, seen live): one Mac-side join died with
  `closed before join: -1 EOFException` (a one-off network drop; an immediate retry worked). The CLI has no retry and
  the app treats a first-attempt socket failure as `Failed`.
- Lag when following (user report) was **not** diagnosed before follow was removed. Walking speed in WorkAdventure is
  `WOKA_SPEED` 9 × 20 = 180 px/s (running 2.5× = 450 px/s) per `play/src/front/Phaser/Player/Player.ts` and the docs;
  the removed loop moved at 300 px/s, so at walking pace the lag was latency, not top speed.

### G2 live checks on the real phone, 2026-10-06 (measured from the phone's own log and accessibility tree unless marked)

- **Invites, both directions work on the wire.** Incoming: `invited by :David` arrived and the Accept/Decline row showed.
  Outgoing: tapping Invite showed "Invited :David…", then "… accepted your invitation" (17 s, 6 s on a second try) and
  "… declined your invitation" (5.7 s). The user accepted an incoming invite by hand and **the phone walked to them**
  (reported).
- **`AskPosition(LOCATE)` works.** With the user far outside the phone's viewport (player list at 0), accepting an
  invite made the phone locate them, walk across the map, and finish in about 9 s. A walk can only start if the locate
  answered, so that is direct evidence.
- **Invite → accept → walk → bubble, end to end on the fixed build:** `invited by` 11:10:21, `answering … accept`
  11:10:32, `entered bubble 1078` 11:10:39, and "Walking to" cleared by itself 8.5 s after accepting.
- **Leave:** "Not in a room"; 0 foreground services, 0 notification records. The stale-notification bug from the first
  phone run is gone.
- **Bogus room:** "Couldn't join: server error screen: ERROR / …" stays on screen (still there 6 s later; it used to
  vanish in 6 ms), button back to Join, 0 services, 0 notifications.
- **Microphone denied** (revoked with `pm revoke`, real system prompt answered "Don't allow"): the app shows "Microphone
  permission is needed to stay connected in the background"; "Not in a room", no service, no notification, process alive,
  no crash.
- **One continuous 32-minute connection** (see above) and no reconnect events across the invite runs.
- **Walk with the screen locked** (2026-10-06, merged build): walk-to started, phone locked over adb (`mWakefulness=Dozing`
  throughout). The session stayed connected, the microphone-type foreground service stayed up, and the avatar entered a
  bubble with the player 16 s after the tap with the screen off. On waking there was no "Walking to" row; Leave was clean
  (0 foreground services). Stay-awake was off.

### Bugs the live runs found in my own work (all fixed, each reproduced by a failing test first)

- **Walk-to never finished on a real map** (user: it "stays in walking to mode", and looked like the old follow). Route
  waypoints are tile *centres*, so the avatar could only park within ~22 px of an off-centre goal; my bubble-distance
  fix had tightened the arrival tolerance from 24 px to 8 px, which made the goal unreachable, so the walk re-targeted
  the player every 500 ms until its 120 s timeout, and left the avatar's last message as "moving". My unit tests had no
  map (straight-line walking), which hid it. Fixes: finish the route at the exact goal; end a walk when within 44 px of
  the *player*, checked every step; give up after 30 s.
- **Stand-point could be out of bubble range.** When the spot in front of a player was a wall or off the map, the old
  snap took the first free tile in raster order: 62 px away in the test case, so the walk "arrived" outside bubble range.
  Now the free point nearest us on a ring around the player at bubble spacing. Found only because a test I wrote to
  prove the arrival range used an awkward geometry. Mutation checking (disabling the range and timeout, confirming the
  tests then fail) also showed one of my first new tests wasn't discriminating, and it was replaced.
- **The logging build printed another player's account email.** For logged-in players the protocol's "user uuid" is the
  account email address (seen: `inviting david@…`). Logs now carry names and user ids only. Worth knowing for the future:
  `Player.uuid` / `Invite.senderUuid` are PII for logged-in accounts.
- **"No bubble formed" once**, even after walking away and back and leaving and rejoining; it worked after the user
  reloaded their browser tab (reported), and then reliably (bubble entered 7 s after accepting, measured). Treated as a
  browser-side glitch; the connection now logs `entered bubble` / `left bubble` so the phone's side is visible next time.

Small UX wart noted for #77: the last invite result ("… declined your invitation") stays on screen indefinitely.

Open: the lock-screen-while-walking run (the 32-minute soak ran locked part of the time, but not mid-walk).

## G1 — real phone (Galaxy S25 Ultra `SM-S938B`, Android 16 / One UI), 2026-10-05

**Verdict: passed with caveats. Presence survived a locked-screen run on a real
phone, but the run was shorter than the 10 minutes in the spec and the evidence
for "list stayed current" is the user's report, not a measurement.**

- **Measured (adb):** the foreground service ran `21:36:50` → `21:43:20`
  (6 min 30 s, from the OS's FGS state log); it ended with notification-removal
  reason 8 (cancelled by the app), matching the user tapping **Leave** at the
  end. The app process stayed alive throughout (same pid), standby bucket was
  ACTIVE (10), and the crash buffer and main log had **no** FATAL / ANR / kill
  lines for the package.
- **Reported by the user:** "that seemed to work" — presence held while the
  phone was locked. Not independently measured.
- **Not captured:** the exact screen-lock duration (the screen was `Dozing` when
  I looked afterwards), whether any silent reconnect happened (the app doesn't
  log them yet; a `Reconnecting` status would only be seen by someone looking),
  the real permission prompts and what the user saw, and whether OkHttp's 20 s
  `pingInterval` mattered. A longer soak is still worth doing (G2 usage will
  provide one).
- **Bug found by this run: a stale notification stayed after Leave.** For at
  least ~7 minutes after the foreground notification was cancelled (until
  `21:50:44`, when I looked) a notification record remained posted with
  `flags=ONGOING_EVENT` and **without** `FOREGROUND_SERVICE`, i.e. something
  posted it after the service stopped. Cause (evidence-backed hypothesis, not
  reproduced under a debugger): `Leave` sets the state to `Disconnected`
  immediately and `stopSelf()` follows, but the observer coroutine on another
  thread can still call `notify()` after the system has removed the foreground
  notification; cancelling its job doesn't wait for a `notify()` in flight.
  Fix: all posting goes through a lock + `active` flag, and `deactivate()` (flag
  off + `cancel(NOTIF_ID)`) runs before `Leave`/`stopForeground`. **Not yet
  verified live** (needs the fixed APK installed and a Leave on the phone).
- **Two text bugs on the same notification**, found in the same dump and fixed
  with a test: `Connected · 1 players` (now `1 player`), and a `Disconnected`
  state rendered as `Connecting…` (now `Not in a room`). Both now live in the
  pure, tested `notificationText()`.

## G1 — whole-branch review (fresh reviewer): what it found and what changed

No Critical findings; the protocol layer and the five plan "focus" cases held up.
Four Important findings were real and are fixed, each with a test that failed
first (suite now 44 tests, 0 failures):

- **Leave/re-Join leaked a coroutine** that kept mirroring the *old* connection
  into the session state, so after Leave the UI could show "Not in a room" with
  players listed, or a new room could show the previous room's players.
  `WaSession` now runs each connection inside its own `coroutineScope`.
- **Leave raced the connect loop across threads.** A late write from a cancelled
  run could turn `Disconnected` back into `Reconnecting`. Every state write and
  connection adoption is now gated by a generation counter under a lock.
- **A failed first join left the socket open and the microphone foreground
  service running.** `connect()` now closes itself on any failure (including
  being cancelled by a Leave, which also closes a small ghost-socket window), and
  the service stops itself on `Failed`. The service half is platform glue and is
  **not verified live**.
- **A silent server hung "Connecting…" forever** (the plan's own "never hang"
  case). There is now a 20 s join timeout.
- **Connections that join and drop immediately reconnected every second**, each
  with a fresh anonymous login: hammering prod and flickering an avatar in a shared
  room. Backoff now resets only after a connection has stayed up 30 s.

Still **open** (deferred minors, in the ledger): a first-attempt transport
failure is final while a login failure retries; mid-session server errors and
reconnect reasons are dropped silently and nothing logs `PusherConnection.log`
(so "did a silent reconnect happen?" still can't be answered on a phone; add logcat
output before the next soak); `Wa133` is named "frozen 1.33" but holds the 1.34
hash; the reconnect countdown text never counts down.

## G1 — emulator

Emulator: Pixel-class AVD `Medium_Phone_API_35` (Android 15), debug APK, 2026-10-05.

- **Works:** join → `Connecting…` → `Connected` in about 8–10 s on the emulator
  (login + `/map` + `.wam` + websocket), 3 players and 20 areas listed, no crash,
  no `SecurityException`. `PresenceService` runs as `isForeground=true`,
  `types=0x80` (`microphone`) on API 35. Notification has the Leave action; Leave
  from the UI sets `Not in a room` and stops the service and notification.
- **Doze (forced, `dumpsys battery unplug` + `deviceidle force-idle`, state read
  back as `IDLE`):** with the app backgrounded, a stand-in avatar joined (list
  went 3 → 4) and left (4 → 3); status stayed `Connected`. So the websocket kept
  delivering room events under forced deep Doze, and a backgrounded activity
  being recreated didn't touch the session (the process and service live
  independently of the activity).
- **Caveats (what this does NOT prove):** forced Doze via `dumpsys` doesn't
  reproduce a real device's network restrictions or OEM battery managers; the
  permissions were pre-granted with `adb shell pm grant` so the real permission
  flow (and its denial path) is untested; no 10-minute screen-locked run; I did
  not capture whether a silent reconnect happened (status would have shown
  `Reconnecting`, and I only sampled it at a few points); whether OkHttp's
  20 s `pingInterval` is needed is unmeasured.
- **Launch command in the plan was wrong:** `am start -n app.workadventurer/.MainActivity`
  expands against the `applicationId`, but the class lives under the `namespace`
  (`app.workadventurer.app`). Use `app.workadventurer/app.workadventurer.app.MainActivity`.
- **Emulator AVD is `Medium_Phone_API_35`**, not `Medium_Phone` (`emulator -list-avds`).
- **`adb shell input text` dropped characters:** typed `android-client-spec-emu`,
  the field held `and`, so the avatar joined the real room briefly as **`and`**
  instead of a worktree-derived name (a hygiene miss; it left cleanly). Probably
  `input text` racing Compose recomposition, but **unverified**: the real-phone
  run (real typing) will show if it's an app bug.
- **A system dialog ("Messages isn't responding", the emulator's own Google
  Messages app) pushed our activity to the background twice** while the device
  was force-idled. Not our app; the process and service survived both times.

## G0

- **Wire does not bundle `google/protobuf/field_mask.proto`.** It resolves
  `wrappers` and `struct` but fails on `FieldMask`
  (`unable to find google/protobuf/field_mask.proto`, from
  `UpdateSpaceUserMessage.updateMask`). Fixed by vendoring a minimal
  `field_mask.proto` into `protocol/src/wire-extra/` as an extra Wire source dir.
  `proto/` itself is untouched.
- **Prod moved to v1.34.0 and rejects the 1.33 `apiVersionHash`es.** First live run
  (2026-10-05, hash `05489a87`): login, `/map`, spawn and the websocket upgrade
  (token as `Sec-WebSocket-Protocol`, `Origin` header) all worked, then the server
  sent `errorScreenMessage` "Please refresh / A new version of WorkAdventure is
  available". `play.workadventu.re/` reports `v1.34.0`. Hash for that tag, from
  `node scripts/vendor-proto.mjs --check v1.34.0` (read-only): **`23c8eb8c`**.
  Re-run with that hash: joined as a normal player, saw the others, in-area
  detection worked. So the **1.33 proto still decodes against a 1.34.0 server**;
  the hash was the only blocker. The Android default is now `23c8eb8c`
  (`Wa133.API_VERSION_HASHES[0]`, old hashes kept); `--api-version` / 
  `RoomConfig.apiVersionHash` override it to probe a build with no adapter.
  **Not verified:** that the Node CLI fails the same way on prod (same mechanism,
  so very likely: its wa-1.33 adapter sends `05489a87`). It needs a proper
  `wa-1.34` adapter / vendored proto. That's repo-wide adapter work, deliberately
  not done here.
- OkHttp passes a manually set `Sec-WebSocket-Protocol` header through unchanged
  and doesn't require the server to echo it: the risk flagged in the plan didn't
  materialise.
- The vendored proto has no `package` line; `protoWithPackage` copies it with
  `package app.workadventurer.proto;` injected. Wire codegen and a round-trip of
  `ClientToServerMessage.joinRoomFrontMessage` verified.
