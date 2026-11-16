import { test } from "node:test";
import assert from "node:assert/strict";
import { parseQueryValidator } from "../scripts/lib/query-validator.mjs";

// v1.31.1+ form: the route's `queryValidator`.
const NEW = `
  this.roomSocketController.ws("/ws/room", {
    queryValidator: z.object({
      roomId: z.string(),
      characterTextureIds: z.union([z.string(), z.string().array()]).optional(),
      version: z.string(),
      cameraState: z.string().transform((val) => val === "true"),
      tabId: z.string().min(1),
      connectionId: z.string().optional(),
    }),
    upgrade: async () => {}
  });`;

// up to v1.31.0: `validateWebsocketQuery(req, res, ctx, z.object({...}))`, with a comment inside the object.
const OLD = `
  const query = validateWebsocketQuery(req, res, context, z.object({
      roomId: z.string(),
      x: z.coerce.number(),
      // tabId is optional because it is not always present
      tabId: z.string().optional(),
      version: z.string(),
  }));`;

test("parses the queryValidator form: required vs optional, nested calls and transforms included", () => {
  const r = parseQueryValidator(NEW);
  assert.deepEqual([...r.required].sort(), ["cameraState", "roomId", "tabId", "version"]);
  assert.deepEqual([...r.optional].sort(), ["characterTextureIds", "connectionId"]);
});

test("parses the older validateWebsocketQuery form, comments and all", () => {
  const r = parseQueryValidator(OLD);
  assert.deepEqual([...r.required].sort(), ["roomId", "version", "x"]);
  assert.deepEqual([...r.optional], ["tabId"]);
});

test("returns null when there is no handshake schema", () => {
  assert.equal(parseQueryValidator("export const x = 1;"), null);
});
