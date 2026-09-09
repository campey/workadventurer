// Headless WorkAdventure client.
//
// Speaks the pusher `/ws/room` WebSocket + protobuf protocol directly (no
// browser, no game engine). Enough of it to join a room as an avatar, see
// other players, and walk around.
//
// Protocol reverse-engineered from workadventure v1.33.5:
//   play/src/front/Connection/RoomConnection.ts   (client side)
//   play/src/pusher/controllers/IoSocketController.ts (server side)

import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import WebSocket from "ws";
import protobuf from "protobufjs";
import { MapNav } from "./map-nav.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Ports of WorkAdventure's helpers (libs/shared-utils) — used to derive the
// space name of a map-area meeting the same way the front-end does.
function shortHash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h << 5) - h + s.charCodeAt(i);
    h |= 0;
  }
  return Math.abs(h).toString(36);
}
function slugify(...args) {
  return args
    .join(" ")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9-_ ]/g, "")
    .replace(/\s+/g, "-");
}

const DEFAULTS = {
  pusherUrl: "https://pusher.workadventu.re",
  roomUrl: "https://play.workadventu.re/@/afrolabs/afrolabs/open-space",
  // apiVersionHash for the deployed build (v1.33.5). Must match the server or
  // the socket is closed straight after upgrade with a "new version" screen.
  version: "bfd20fc4",
  // A texture id from GET /woka/list for this room ("Bob" in the default set).
  wokaId: "506a3a64-47a9-4587-b19b-2d1eb13f9790",
  name: "claude",
  // Spawn coordinates (pixels). Movement is client-authoritative, so this only
  // affects where the avatar first appears.
  spawn: { x: 320, y: 320 },
};

const DIRECTION = { UP: 0, RIGHT: 1, DOWN: 2, LEFT: 3 };
const AVAILABILITY_ONLINE = 1;

export class WorkAdventureClient extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.cfg = { ...DEFAULTS, ...opts };
    this.token = null;
    this.ws = null;
    this.myUserId = null;
    /** @type {Map<number, {userId:number,name:string,x:number,y:number,uuid:string}>} */
    this.players = new Map();
    this._root = null;
    this._C2S = null;
    this._S2C = null;
    this._joined = false;
    this._keepAlive = null;
    this._outSeq = 1;

    // Proximity-meeting ("Space") state, populated once the server asks us to
    // join a Space (which it does when we enter a bubble). See _handle().
    this.micOn = !!opts.micOn;
    this._qid = 1;
    this._pendingQueries = new Map(); // id -> { resolve, reject, timer }
    /** @type {Map<string,{spaceUserId:string,propertiesToSync:string[]}>} */
    this.spaces = new Map(); // spaceName -> our membership
    this.groupId = null; // current proximity group, or null

    // Map areas (from the room's .wam) and which ones the avatar is inside.
    /** @type {{name:string,x:number,y:number,w:number,h:number,props:Record<string,unknown>}[]} */
    this.areas = [];
    this.currentAreas = new Set(); // area names the avatar is currently within

    if (opts.nav !== undefined) {
      this.nav = opts.nav;
    } else {
      try {
        this.nav = MapNav.loadForRoom(this.cfg.roomUrl);
      } catch (e) {
        // No baked map for this room -> straight-line movement, no pathfinding.
        this.nav = null;
        this.emit("log", `no baked map for this room (${e.code === "ENOENT" ? "run scripts/build-collision.mjs" : e.message}) — straight-line movement`);
      }
    }

    // Spawn: explicit `spawn` opt wins; otherwise a random tile from the map's
    // `start` layer (what WorkAdventure itself uses); otherwise the fallback.
    const navSpawn = this.nav?.randomSpawnPx();
    const spawn =
      opts.spawn ??
      (navSpawn ? { x: navSpawn[0], y: navSpawn[1] } : this.cfg.spawn);
    this.pos = { x: spawn.x, y: spawn.y, direction: DIRECTION.DOWN, moving: false };
  }

  async _loadProto() {
    if (this._root) return;
    this._root = await protobuf.load(path.join(__dirname, "..", "proto", "messages.proto"));
    this._C2S = this._root.lookupType("ClientToServerMessage");
    this._S2C = this._root.lookupType("ServerToClientMessage");
  }

  async _anonymLogin() {
    const res = await fetch(`${this.cfg.pusherUrl}/anonymLogin`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    if (!res.ok) throw new Error(`anonymLogin failed: ${res.status} ${await res.text()}`);
    const data = await res.json();
    this.token = data.authToken;
    this.emit("log", `anonymLogin ok (uuid ${data.userUuid})`);
    return data;
  }

  _wsUrl() {
    const u = new URL("/ws/room", this.cfg.pusherUrl);
    u.protocol = u.protocol.replace("http", "ws");
    u.searchParams.set("roomId", this.cfg.roomUrl);
    u.searchParams.append("characterTextureIds", this.cfg.wokaId);
    u.searchParams.set("version", this.cfg.version);
    u.searchParams.set("roomName", "");
    u.searchParams.set("cameraState", "false");
    u.searchParams.set("microphoneState", this.micOn ? "true" : "false");
    u.searchParams.set("screenSharingState", "false");
    u.searchParams.set("chatID", "");
    u.searchParams.set("tabId", randomUUID().slice(0, 12));
    return u.toString();
  }

  _viewport() {
    // Must be a normal-sized window CENTERED ON US. The pusher caps a viewport
    // at MAX_ZONES_PER_VIEWPORT (1600) and, if exceeded, re-centers the crop on
    // the viewport's own centre — so a giant rect subscribes us to zones far
    // from the avatar and we see nobody. ~3840x2160 = 12x7 zones of 320px.
    const halfW = 1920;
    const halfH = 1080;
    return {
      left: Math.max(0, Math.round(this.pos.x - halfW)),
      top: Math.max(0, Math.round(this.pos.y - halfH)),
      right: Math.round(this.pos.x + halfW),
      bottom: Math.round(this.pos.y + halfH),
    };
  }

  // Fetch the room's map areas (name, bounds, properties) so we can tell when
  // the avatar walks into a meeting / silent / megaphone zone. Best-effort:
  // a failure just leaves `this.areas` empty.
  async _loadAreas() {
    const get = (u) => fetch(u, { signal: AbortSignal.timeout(8000) }).then((r) => r.json());
    try {
      const mapInfo = await get(
        `${this.cfg.pusherUrl}/map?playUri=${encodeURIComponent(this.cfg.roomUrl)}`
      );
      if (!mapInfo.wamUrl) return;
      const wam = await get(mapInfo.wamUrl);
      this.areas = (wam.areas ?? []).map((a) => ({
        id: a.id,
        name: a.name || "(unnamed)",
        x: a.x, y: a.y, w: a.width, h: a.height,
        props: Object.fromEntries(
          (a.properties ?? []).map((p) => [p.type ?? p.name, p.value ?? p.name ?? true])
        ),
        rawProps: a.properties ?? [],
      }));
      this.emit("log", `loaded ${this.areas.length} map areas`);
    } catch (e) {
      this.emit("log", `map areas unavailable: ${e.message}`);
    }
  }

  /** Which areas contain a point. */
  areasAt(x = this.pos.x, y = this.pos.y) {
    return this.areas.filter(
      (a) => x >= a.x && x <= a.x + a.w && y >= a.y && y <= a.y + a.h
    );
  }

  // Recompute area membership and emit areaEnter / areaLeave. Cheap; called on
  // every move. Never throws — a bad area definition must not break movement.
  _updateAreas() {
    if (!this.areas.length) return;
    try {
      const now = new Set();
      for (const a of this.areasAt()) {
        now.add(a.id ?? a.name);
        if (!this.currentAreas.has(a.id ?? a.name)) {
          this.emit("areaEnter", a);
          this._handleAreaMeeting(a, true);
        }
      }
      for (const key of this.currentAreas) {
        if (!now.has(key)) {
          const a = this.areas.find((z) => (z.id ?? z.name) === key);
          this.emit("areaLeave", a ?? { name: key });
          if (a) this._handleAreaMeeting(a, false);
        }
      }
      this.currentAreas = now;
    } catch (e) {
      this.emit("log", `area update error: ${e.message}`);
    }
  }

  async connect() {
    await this._loadProto();
    if (!this.token) await this._anonymLogin();
    await this._loadAreas();

    const url = this._wsUrl();
    this.emit("log", `connecting ${url}`);
    // The JWT is smuggled as the WebSocket subprotocol (see IoSocketController).
    this.ws = new WebSocket(url, [this.token], {
      headers: { Origin: "https://play.workadventu.re" },
    });

    this.ws.on("open", () => {
      this.emit("log", "socket open; waiting for roomConnectedMessage");
    });

    this.ws.on("message", (data) => this._onMessage(data));
    this.ws.on("close", (code, reason) => {
      if (this._keepAlive) clearInterval(this._keepAlive);
      this.emit("close", { code, reason: reason?.toString() });
    });
    this.ws.on("error", (err) => this.emit("error", err));

    return new Promise((resolve, reject) => {
      const onJoin = () => { cleanup(); resolve(this); };
      const onClose = (c) => { cleanup(); reject(new Error(`closed before join: ${c.code} ${c.reason}`)); };
      const onErr = (e) => { cleanup(); reject(e); };
      const cleanup = () => {
        this.off("joined", onJoin); this.off("close", onClose); this.off("error", onErr);
      };
      this.once("joined", onJoin);
      this.once("close", onClose);
      this.once("error", onErr);
    });
  }

  // The deployed pusher build wraps every frame in an outer envelope that is
  // not in the public protos:  { 1: seq (varint), 2: <inner message bytes> }.
  // Field 2 can repeat (several inner messages batched in one frame).
  _wrap(payload) {
    const lenv = [];
    let n = payload.length;
    do { let b = n & 0x7f; n >>>= 7; if (n) b |= 0x80; lenv.push(b); } while (n);
    const seqv = [];
    let s = this._outSeq++;
    do { let b = s & 0x7f; s = Math.floor(s / 128); if (s) b |= 0x80; seqv.push(b); } while (s);
    return Buffer.concat([
      Buffer.from([0x08, ...seqv]), // field 1, varint
      Buffer.from([0x12, ...lenv]), // field 2, length-delimited
      Buffer.from(payload),
    ]);
  }

  _unwrap(buf) {
    const reader = protobuf.Reader.create(buf);
    const payloads = [];
    let seq = null;
    while (reader.pos < reader.len) {
      const tag = reader.uint32();
      const field = tag >>> 3;
      const wire = tag & 7;
      if (field === 1 && wire === 0) seq = reader.uint64();
      else if (field === 2 && wire === 2) payloads.push(reader.bytes());
      else reader.skipType(wire);
    }
    return { seq, payloads };
  }

  _send(messageObj) {
    const err = this._C2S.verify(messageObj);
    if (err) throw new Error(`C2S verify: ${err}`);
    const buf = this._C2S.encode(this._C2S.create(messageObj)).finish();
    this.ws.send(this._wrap(buf));
  }

  /**
   * Send a `queryMessage` and resolve with the matching `answerMessage`'s inner
   * answer. `kind` is the oneof field name (e.g. "joinSpaceQuery"). Rejects on
   * an error answer or timeout.
   */
  query(kind, payload, { timeoutMs = 10000 } = {}) {
    const id = this._qid++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pendingQueries.delete(id);
        reject(new Error(`query ${kind} #${id} timed out`));
      }, timeoutMs);
      this._pendingQueries.set(id, { resolve, reject, timer });
      this._send({ queryMessage: { id, [kind]: payload } });
    });
  }

  _resolveQuery(answer) {
    const pend = this._pendingQueries.get(answer.id);
    if (!pend) return;
    this._pendingQueries.delete(answer.id);
    clearTimeout(pend.timer);
    if (answer.error) pend.reject(new Error(answer.error.message || "query error"));
    else pend.resolve(answer);
  }

  /**
   * Join the proximity-meeting Space the server just asked us into. Returns our
   * `spaceUserId`. Also announces our current mic state to the other members.
   */
  async _joinSpace(spaceName, propertiesToSync) {
    const props = propertiesToSync?.length
      ? propertiesToSync
      : ["cameraState", "microphoneState", "screenSharingState"];
    const answer = await this.query("joinSpaceQuery", {
      spaceName,
      filterType: 0, // ALL_USERS
      propertiesToSync: props,
    });
    const spaceUserId = answer.joinSpaceAnswer?.spaceUserId ?? "";
    this.spaces.set(spaceName, { spaceUserId, propertiesToSync: props });
    this.emit("log", `joined space ${spaceName} as ${spaceUserId}`);
    // "Watch" the Space. Without this the back keeps us in `users` but not
    // `usersToNotify`, and never sets up peer connections (WebRTCCommunication
    // Strategy.addUser bails for non-watchers). This is what makes the meeting
    // actually connect.
    this._send({ addSpaceFilterMessage: { spaceFilterMessage: { spaceName } } });
    this.emit("spaceJoined", { spaceName, spaceUserId });
    if (this.micOn) this.setSpaceMicState(spaceName, true);
    return spaceUserId;
  }

  async _leaveSpace(spaceName) {
    if (!this.spaces.delete(spaceName)) return;
    this._send({ removeSpaceFilterMessage: { spaceFilterMessage: { spaceName } } });
    this.query("leaveSpaceQuery", { spaceName }).catch(() => {});
    this.emit("log", `left space ${spaceName}`);
    this.emit("spaceLeft", { spaceName });
  }

  // The space name of a map-area meeting, derived the same way the WA front does
  // (AreasPropertiesListener.handleLivekitRoomPropertyOnEnter).
  _areaSpaceName(prop) {
    const roomId = prop.roomName?.trim() ? prop.roomName : prop.id;
    return slugify(shortHash(this.cfg.roomUrl) + "-" + roomId);
  }

  // On entering/leaving a `livekitRoomProperty` area, proactively join/leave its
  // space — the server never invites a headless client to an area meeting the
  // way it does for proximity bubbles.
  _handleAreaMeeting(area, entering) {
    const prop = (area.rawProps ?? []).find((p) => p.type === "livekitRoomProperty");
    if (!prop) return;
    const spaceName = this._areaSpaceName(prop);
    if (entering) {
      if (this.spaces.has(spaceName)) return;
      this.emit("log", `meeting area "${area.name}" → joining space ${spaceName}`);
      this._joinSpace(spaceName).catch((e) =>
        this.emit("log", `area meeting join failed: ${e.message}`)
      );
    } else if (this.spaces.has(spaceName)) {
      this._leaveSpace(spaceName);
    }
  }

  /** Tell the other Space members whether our mic is live. */
  setSpaceMicState(spaceName, on) {
    const mine = this.spaces.get(spaceName);
    if (!mine) return;
    this._send({
      updateSpaceUserMessage: {
        spaceName,
        user: { spaceUserId: mine.spaceUserId, microphoneState: !!on },
        updateMask: { paths: ["microphoneState"] },
      },
    });
  }

  /** Send a PrivateSpaceEvent (webRtcSignal, webRtcStartMessage, …) to one member. */
  sendSpacePrivateEvent(spaceName, receiverUserId, event) {
    this._send({
      privateEvent: { spaceName, receiverUserId, spaceEvent: event },
    });
  }

  _onMessage(data) {
    const bytes = data instanceof ArrayBuffer ? Buffer.from(new Uint8Array(data)) : data;
    let payloads;
    try {
      ({ payloads } = this._unwrap(bytes));
    } catch (e) {
      this.emit("log", `unwrap error: ${e.message} (${Buffer.from(bytes).toString("hex")})`);
      return;
    }
    for (const p of payloads) {
      let obj;
      try {
        obj = this._S2C.toObject(this._S2C.decode(p), { enums: Number, longs: Number, defaults: false });
      } catch (e) {
        this.emit("log", `decode error: ${e.message} (${Buffer.from(p).toString("hex")})`);
        continue;
      }
      this._handle(obj);
    }
  }

  _handle(obj) {
    if (obj.batchMessage) {
      for (const sub of obj.batchMessage.payload ?? []) this._handleSub(sub);
      return;
    }
    if (obj.roomConnectedMessage) {
      this.emit("log", "roomConnectedMessage received; sending joinRoomFrontMessage");
      this._send({
        joinRoomFrontMessage: {
          name: this.cfg.name,
          positionMessage: {
            x: Math.round(this.pos.x),
            y: Math.round(this.pos.y),
            direction: this.pos.direction,
            moving: false,
          },
          viewportMessage: this._viewport(),
          availabilityStatus: AVAILABILITY_ONLINE,
        },
      });
      return;
    }
    if (obj.roomJoinedMessage) {
      this.myUserId = obj.roomJoinedMessage.currentUserId ?? null;
      this._joined = true;
      this.emit("log", `joined room as userId ${this.myUserId}`);
      this._startKeepAlive();
      this.emit("joined", obj.roomJoinedMessage);
      return;
    }
    if (obj.errorScreenMessage) {
      this.emit("log", `errorScreen: ${JSON.stringify(obj.errorScreenMessage)}`);
      this.emit("error", new Error(`server error screen: ${obj.errorScreenMessage.title ?? ""} / ${obj.errorScreenMessage.details ?? obj.errorScreenMessage.subtitle ?? ""}`));
      return;
    }
    if (obj.errorMessage) { this.emit("log", `errorMessage: ${obj.errorMessage.message}`); return; }
    if (obj.invalidCharacterTextureMessage) { this.emit("error", new Error("invalid character texture")); return; }
    if (obj.tokenExpiredMessage) { this.emit("error", new Error("token expired")); return; }

    if (obj.answerMessage) { this._resolveQuery(obj.answerMessage); return; }
    if (obj.joinSpaceRequestMessage) {
      const { spaceName, propertiesToSync } = obj.joinSpaceRequestMessage;
      if (!this.spaces.has(spaceName)) {
        this._joinSpace(spaceName, propertiesToSync).catch((e) =>
          this.emit("log", `joinSpace failed: ${e.message}`)
        );
      }
      return;
    }
    if (obj.leaveSpaceRequestMessage) {
      this._leaveSpace(obj.leaveSpaceRequestMessage.spaceName);
      return;
    }
    // roomConnectedMessage, worldConnectionMessage, refreshRoomMessage, etc. — ignored.
    if (process.env.WA_DEBUG) {
      const k = Object.keys(obj)[0];
      if (k && k !== "batchMessage") this.emit("log", `S2C ${k}: ${JSON.stringify(obj[k]).slice(0, 400)}`);
    }
  }

  _handleSub(sub) {
    if (sub.pingMessage) {
      this._send({ pingMessage: {} });
      return;
    }
    if (sub.userJoinedMessage) {
      const u = sub.userJoinedMessage;
      this.players.set(u.userId, {
        userId: u.userId,
        name: u.name ?? "",
        uuid: u.userUuid ?? "",
        x: u.position?.x ?? 0,
        y: u.position?.y ?? 0,
      });
      this.emit("playerJoined", this.players.get(u.userId));
      return;
    }
    if (sub.userMovedMessage) {
      const m = sub.userMovedMessage;
      const p = this.players.get(m.userId);
      if (p && m.position) { p.x = m.position.x; p.y = m.position.y; }
      this.emit("playerMoved", p);
      return;
    }
    if (sub.userLeftMessage) {
      this.players.delete(sub.userLeftMessage.userId);
      this.emit("playerLeft", sub.userLeftMessage.userId);
      return;
    }
    if (sub.groupUpdateMessage) {
      const g = sub.groupUpdateMessage;
      // Group updates arrive for any group in view, not just ours — only track
      // the one we're actually a member of.
      const mine = g.userIds?.includes(this.myUserId);
      if (mine && this.groupId !== g.groupId) {
        this.groupId = g.groupId;
        this.emit("bubbleEntered", { groupId: g.groupId });
      } else if (!mine && this.groupId === g.groupId) {
        this.groupId = null;
        this.emit("bubbleLeft", {});
      }
      if (mine) this.emit("group", { groupId: g.groupId, userIds: g.userIds ?? [] });
      return;
    }
    if (sub.groupDeleteMessage) {
      if (this.groupId === sub.groupDeleteMessage.groupId) {
        this.groupId = null;
        this.emit("bubbleLeft", {});
      }
      return;
    }
    if (sub.privateEvent) {
      const pe = sub.privateEvent;
      const ev = pe.spaceEvent ?? {};
      const [kind] = Object.keys(ev);
      if (kind) {
        this.emit("spaceEvent", {
          spaceName: pe.spaceName,
          senderUserId: pe.sender?.spaceUserId ?? pe.senderUserId,
          sender: pe.sender,
          kind,
          payload: ev[kind],
        });
      }
      return;
    }
    // emoteEventMessage, variableMessage, publicEvent, other space* — ignored.
    if (process.env.WA_DEBUG) {
      const k = Object.keys(sub)[0];
      if (k && k !== "userMovedMessage") this.emit("log", `SUB ${k}: ${JSON.stringify(sub[k]).slice(0, 300)}`);
    }
  }

  _startKeepAlive() {
    if (this._keepAlive) clearInterval(this._keepAlive);
    // Re-broadcast our position periodically so we don't look stale.
    this._keepAlive = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) this._emitMove(false);
    }, 5000);
  }

  _emitMove(moving) {
    this._send({
      userMovesMessage: {
        position: {
          x: Math.round(this.pos.x),
          y: Math.round(this.pos.y),
          direction: this.pos.direction,
          moving,
        },
        viewport: this._viewport(),
      },
    });
    this._updateAreas();
  }

  listPlayers() {
    return [...this.players.values()];
  }

  findPlayer(nameNeedle) {
    const n = nameNeedle.trim().toLowerCase();
    return this.listPlayers().find((p) => p.name.trim().toLowerCase() === n)
      ?? this.listPlayers().find((p) => p.name.trim().toLowerCase().includes(n));
  }

  /**
   * Walk toward (targetX, targetY) in steps, streaming position updates, until
   * within `stopWithin` px or `getTarget()` returns null. If `getTarget` is
   * given it is re-read each tick so we track a moving player.
   */
  async walkTo(targetX, targetY, { stopWithin = 48, stepPx = 32, tickMs = 120, getTarget = null, timeoutMs = 60000 } = {}) {
    const started = Date.now();
    for (;;) {
      if (Date.now() - started > timeoutMs) return { arrived: false, reason: "timeout" };
      let tx = targetX, ty = targetY;
      if (getTarget) {
        const t = getTarget();
        if (!t) return { arrived: false, reason: "target-gone" };
        tx = t.x; ty = t.y;
      }
      const dx = tx - this.pos.x;
      const dy = ty - this.pos.y;
      const dist = Math.hypot(dx, dy);
      if (dist <= stopWithin) {
        this.pos.moving = false;
        this._emitMove(false);
        return { arrived: true, dist };
      }
      const step = Math.min(stepPx, dist);
      this.pos.x += (dx / dist) * step;
      this.pos.y += (dy / dist) * step;
      this.pos.direction = Math.abs(dx) > Math.abs(dy)
        ? (dx > 0 ? DIRECTION.RIGHT : DIRECTION.LEFT)
        : (dy > 0 ? DIRECTION.DOWN : DIRECTION.UP);
      this.pos.moving = true;
      this._emitMove(true);
      await new Promise((r) => setTimeout(r, tickMs));
    }
  }

  /**
   * Walk to (targetX,targetY) following an A* route around walls/furniture
   * (falls back to straight-line if the map nav is unavailable or no route is
   * found). Re-plans every `repathMs` so it tracks a moving `getTarget()`.
   */
  async navTo(targetX, targetY, { stopWithin = 48, getTarget = null, timeoutMs = 120000, repathMs = 2000, face = null } = {}) {
    if (this._navBusy) return { arrived: false, reason: "busy" };
    this._navBusy = true;
    try {
      return await this._navTo(targetX, targetY, { stopWithin, getTarget, timeoutMs, repathMs, face });
    } finally {
      this._navBusy = false;
    }
  }

  // `face` may be a {x,y} point or a () => {x,y} getter; on arrival the avatar
  // turns to look at it instead of keeping its last travel direction.
  async _navTo(targetX, targetY, { stopWithin, getTarget, timeoutMs, repathMs, face }) {
    const lookAt = () => {
      const p = typeof face === "function" ? face() : face;
      if (p) this._faceToward(p.x, p.y);
    };
    if (!this.nav) {
      const r = await this.walkTo(targetX, targetY, { stopWithin, getTarget, timeoutMs });
      if (r.arrived) lookAt();
      return r;
    }
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      let gx = targetX, gy = targetY;
      if (getTarget) {
        const t = getTarget();
        if (!t) return { arrived: false, reason: "target-gone" };
        gx = t.x; gy = t.y;
      }
      if (Math.hypot(gx - this.pos.x, gy - this.pos.y) <= stopWithin) {
        this.pos.moving = false;
        this._emitMove(false);
        lookAt();
        return { arrived: true };
      }
      const path = this.nav.findPath(this.pos.x, this.pos.y, gx, gy);
      if (!path || path.length === 0) {
        await this.walkTo(gx, gy, { stopWithin, timeoutMs: repathMs, getTarget });
        continue;
      }
      const deadline = Date.now() + repathMs;
      for (const [wx, wy] of path) {
        if (Date.now() > deadline) break;
        const r = await this.walkTo(wx, wy, { stopWithin: 12, stepPx: 40, tickMs: 100, timeoutMs: repathMs });
        if (!r.arrived) break;
      }
    }
    return { arrived: false, reason: "timeout" };
  }

  _faceToward(x, y) {
    const dx = x - this.pos.x;
    const dy = y - this.pos.y;
    const dir = Math.abs(dx) > Math.abs(dy)
      ? (dx > 0 ? DIRECTION.RIGHT : DIRECTION.LEFT)
      : (dy > 0 ? DIRECTION.DOWN : DIRECTION.UP);
    if (dir !== this.pos.direction) {
      this.pos.direction = dir;
      this.pos.moving = false;
      this._emitMove(false);
    }
  }

  /**
   * Where to stand relative to `target`: `spacing` px short of them, on the
   * side they're approached from — unless the target is inside an enclosed
   * room and we're not, in which case a spot just outside that room's door.
   */
  followPoint(target, spacing = 72) {
    const tx = target.x;
    const ty = target.y;
    if (this.nav) {
      const room = this.nav.roomAt(tx, ty);
      const mine = this.nav.roomAt(this.pos.x, this.pos.y);
      if (room && (!mine || mine.name !== room.name)) {
        const reachable = (px, py) => !!this.nav.findPath(this.pos.x, this.pos.y, px, py);
        const p = this.nav.pointOutsideRoom(room, tx, ty, reachable);
        if (p) return { x: p[0], y: p[1], room: room.name };
      }
    }
    let dx = this.pos.x - tx;
    let dy = this.pos.y - ty;
    let d = Math.hypot(dx, dy);
    if (d < 1) { dx = 0; dy = 1; d = 1; }
    let gx = tx + (dx / d) * spacing;
    let gy = ty + (dy / d) * spacing;
    if (this.nav?.isPxBlocked(gx, gy)) {
      const [tX, tY] = this.nav.pxToTile(gx, gy);
      const free = this.nav.nearestFree(tX, tY);
      if (free) [gx, gy] = this.nav.tileCenterPx(free[0], free[1]);
    }
    return { x: gx, y: gy };
  }

  /**
   * Fluidly follow a moving target: small steps every ~100 ms along a route
   * that is re-planned a few times a second, easing to a stop at `followPoint`.
   * Resolves when `getTarget()` returns null or `signal` aborts.
   */
  async follow(getTarget, { spacing = 72, tickMs = 100, stepPx = 30, arriveSlack = 20, signal } = {}) {
    if (this._navBusy) return { reason: "busy" };
    this._navBusy = true;
    try {
      let path = null;
      let pathAt = 0;
      let pathGoal = null;
      while (!signal?.aborted) {
        const target = getTarget();
        if (!target) return { reason: "target-gone" };
        const goal = this.followPoint(target, spacing);
        const dGoal = Math.hypot(goal.x - this.pos.x, goal.y - this.pos.y);

        if (dGoal <= arriveSlack) {
          this._faceToward(target.x, target.y);
          path = null;
          await new Promise((r) => setTimeout(r, tickMs * 2));
          continue;
        }

        const stale =
          !path || path.length === 0 || Date.now() - pathAt > 700 ||
          !pathGoal || Math.hypot(pathGoal.x - goal.x, pathGoal.y - goal.y) > 80;
        if (stale) {
          const raw = this.nav?.findPath(this.pos.x, this.pos.y, goal.x, goal.y);
          path = (raw && raw.length ? raw : [[goal.x, goal.y]]).map(([x, y]) => ({ x, y }));
          pathAt = Date.now();
          pathGoal = goal;
        }

        let wp = path[0];
        let dwp = Math.hypot(wp.x - this.pos.x, wp.y - this.pos.y);
        while (dwp <= stepPx && path.length > 1) {
          path.shift();
          wp = path[0];
          dwp = Math.hypot(wp.x - this.pos.x, wp.y - this.pos.y);
        }

        const step = Math.min(stepPx, Math.max(dwp, dGoal));
        if (dwp > 0.001) {
          this.pos.x += ((wp.x - this.pos.x) / dwp) * step;
          this.pos.y += ((wp.y - this.pos.y) / dwp) * step;
        }
        this.pos.direction = Math.abs(wp.x - this.pos.x) > Math.abs(wp.y - this.pos.y)
          ? (wp.x >= this.pos.x ? DIRECTION.RIGHT : DIRECTION.LEFT)
          : (wp.y >= this.pos.y ? DIRECTION.DOWN : DIRECTION.UP);
        this.pos.moving = true;
        this._emitMove(true);
        await new Promise((r) => setTimeout(r, tickMs));
      }
      this.pos.moving = false;
      this._emitMove(false);
      return { reason: "aborted" };
    } finally {
      this._navBusy = false;
    }
  }

  // Text over the avatar's head. WorkAdventure's `SayMessage.type` is
  // 0 = SpeechBubble, 1 = ThinkingCloud. Named literally — this is NOT voice.
  speechBubble(message) {
    this._send({ setPlayerDetailsMessage: { sayMessage: { message, type: 0 } } });
  }

  thoughtBubble(message) {
    this._send({ setPlayerDetailsMessage: { sayMessage: { message, type: 1 } } });
  }

  // Dismiss whatever bubble is showing. WorkAdventure clears the bubble on an
  // empty `message`; `type` is irrelevant in that case.
  clearBubble() {
    this._send({ setPlayerDetailsMessage: { sayMessage: { message: "", type: 0 } } });
  }

  close() {
    if (this._keepAlive) clearInterval(this._keepAlive);
    for (const { reject, timer } of this._pendingQueries.values()) {
      clearTimeout(timer);
      reject(new Error("client closed"));
    }
    this._pendingQueries.clear();
    this.ws?.close();
  }
}

export { DIRECTION, DEFAULTS };
