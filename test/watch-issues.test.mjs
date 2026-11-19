import { test } from "node:test";
import assert from "node:assert/strict";
import { reportFailure, reportPass, STAGING_TITLE } from "../scripts/watch/issues.mjs";
import { createGithubPort } from "../scripts/watch/github-port.mjs";

const REPO = "campey/workadventurer";
const RUN = `https://github.com/${REPO}/actions/runs/12345`;
const H1 = "abcdef01";
const H2 = "abcdef02";

const marker = (h) => `<!-- adapter-watch:${h} -->`;
function fakeIssues({ failAt, dropLabels = false, dropAlways = false, truncated = false } = {}) {
  const f = { repo: REPO, issues: [], calls: [], queries: [] };
  let n = 100;
  const boom = (m) => { if (failAt === m) throw new Error(`${m} boom`); };
  f.findIssues = async ({ label, state }) => {
    f.calls.push("find"); f.queries.push({ label, state }); boom("find");
    const issues = f.issues.filter((i) => (!label || i.labels.includes(label)) && (state === "all" || i.state === state)).map(({ number, title, state: s, body }) => ({ number, title, state: s, body: body ?? "" }));
    return { issues, truncated };
  };
  f.createIssue = async ({ title, body, labels }) => { f.calls.push("create"); boom("create"); const i = { number: ++n, title, body, labels: dropLabels ? [] : labels, state: "open", comments: [] }; f.issues.push(i); return { number: i.number, labels: [...i.labels] }; };
  f.addLabels = async (num, labels) => { f.calls.push("addLabels"); const i = f.issues.find((x) => x.number === num); if (!dropAlways) i.labels.push(...labels); return { labels: [...i.labels] }; };
  f.updateIssue = async (num, { title, body }) => { f.calls.push("update"); boom("update"); Object.assign(f.issues.find((i) => i.number === num), { title, body }); return { number: num }; };
  f.closeIssue = async (num, { comment } = {}) => { f.calls.push("close"); boom("close"); const i = f.issues.find((x) => x.number === num); if (comment) i.comments.push(comment); i.state = "closed"; return { closed: true }; };
  return f;
}
const open = (f) => f.issues.filter((i) => i.state === "open");
const fail1 = (port, o = {}) => reportFailure({ port, server: "production", hash: H1, version: "v1.34.5", gate: "selfcheck failed", runUrl: RUN, candidate: { waVersion: "1.34.5", protoFamily: "v1" }, ...o });

test("production failure creates one labelled issue with failure, run link and candidate", async () => {
  const port = fakeIssues();
  const r = await fail1(port);
  assert.deepEqual([r.ok, r.action, r.issue], [true, "created", 101]);
  const i = port.issues[0];
  assert.equal(i.title, `Server v1.34.5 needs attention (adapter ${H1})`);
  assert.deepEqual(i.labels, ["adapter-watch"]);
  assert.match(i.body, /selfcheck failed/);
  assert.ok(i.body.includes(RUN));
  assert.match(i.body, /waVersion `1\.34\.5`, protoFamily `v1`/);
});

test("a repeat failure for the same hash updates the issue, never a second one", async () => {
  const port = fakeIssues();
  await fail1(port);
  const r = await fail1(port, { gate: "scenario failed" });
  assert.deepEqual([r.action, r.issue, r.extras], ["updated", 101, []]);
  assert.equal(port.issues.length, 1);
  assert.match(port.issues[0].body, /scenario failed/);
});

test("different production hashes get different issues", async () => {
  const port = fakeIssues();
  await fail1(port);
  await fail1(port, { hash: H2, version: "v1.34.6" });
  assert.equal(open(port).length, 2);
});

test("several open issues for a hash: oldest updated, extras reported", async () => {
  const port = fakeIssues();
  for (const n of [5, 9, 7]) port.issues.push({ number: n, title: `Server v1.34.5 needs attention (adapter ${H1})`, body: marker(H1), labels: ["adapter-watch"], state: "open", comments: [] });
  const r = await fail1(port);
  assert.deepEqual([r.action, r.issue, r.extras], ["updated", 5, [7, 9]]);
  assert.ok(!port.calls.includes("create"));
});

test("an issue without the label or for another hash is not matched (the labelless one is, via fallback)", async () => {
  const port = fakeIssues();
  port.issues.push({ number: 1, title: `Server v1.34.5 needs attention (adapter ${H1})`, body: "no marker", labels: [], state: "open", comments: [] });
  port.issues.push({ number: 2, title: `Server v1.34.5 needs attention (adapter ${H2})`, body: marker(H2), labels: ["adapter-watch"], state: "open", comments: [] });
  const r = await fail1(port);
  assert.equal(r.action, "created");
});

test("a later pass closes the hash's issue with a comment; others stay open", async () => {
  const port = fakeIssues();
  await fail1(port);
  await fail1(port, { hash: H2 });
  const r = await reportPass({ port, server: "production", hash: H1, version: "v1.34.5", runUrl: RUN });
  assert.deepEqual([r.ok, r.closed], [true, [101]]);
  assert.equal(port.issues[0].state, "closed");
  assert.match(port.issues[0].comments[0], /gate passed/);
  assert.equal(port.issues[1].state, "open");
  assert.deepEqual((await reportPass({ port, server: "production", hash: H1 })).closed, []);
});

test("staging keeps one issue, updated to the newest failing hash, closed by a staging pass", async () => {
  const port = fakeIssues();
  const s = (hash) => reportFailure({ port, server: "staging", hash, version: "master@118dd84c", gate: "x", runUrl: RUN });
  assert.equal((await s(H1)).action, "created");
  const r = await s(H2);
  assert.deepEqual([r.action, r.issue], ["updated", 101]);
  assert.equal(open(port).length, 1);
  assert.equal(port.issues[0].title, STAGING_TITLE);
  assert.ok(port.issues[0].body.includes(H2) && !port.issues[0].body.includes(H1));
  // a production issue for the same hash does not collide with it
  await fail1(port);
  assert.equal(open(port).length, 2);
  const p = await reportPass({ port, server: "staging", hash: "abcdef03" });
  assert.deepEqual(p.closed, [101]);
  assert.equal(port.issues[1].state, "open");
});

test("gate text is fenced, backticks and @ neutralised, control chars gone, length capped", async () => {
  const port = fakeIssues();
  await fail1(port, { gate: "```\n@everyone see http://evil\u0007 `x` " + "y".repeat(500) });
  const body = port.issues[0].body;
  assert.ok(!body.includes("@"));
  assert.equal(body.split("```").length, 3);
  assert.ok(!/[\x00-\x08]/.test(body));
  assert.ok(body.length < 1000);
});

test("unvalidated values are refused before the port is touched", async () => {
  const port = fakeIssues();
  const bad = [
    { hash: "../x" }, { hash: "ABCDEF01" }, { server: "other" }, { version: "v1 @everyone" }, { version: "x".repeat(41) },
    { runUrl: "https://evil.example/actions/runs/1" }, { runUrl: `${RUN}/../x` }, { runUrl: `https://github.com/other/repo/actions/runs/1` }, { runUrl: `${RUN}?x=1` },
  ];
  for (const o of bad) {
    const r = await fail1(port, o);
    assert.deepEqual([r.ok, r.stage], [false, "validate"], JSON.stringify(o));
    assert.equal((await reportPass({ port, server: "production", hash: H1, ...o })).ok, false);
  }
  assert.deepEqual(port.calls, []);
});

test("port failures come back as stages, never thrown", async () => {
  for (const [at, stage] of [["find", "find"], ["create", "create"]]) {
    const r = await fail1(fakeIssues({ failAt: at }));
    assert.deepEqual([r.ok, r.stage], [false, stage]);
  }
  const p = fakeIssues(); await fail1(p); p.calls.length = 0;
  p.updateIssue = async () => { throw new Error("nope"); };
  assert.equal((await fail1(p)).stage, "update");
  const c = fakeIssues(); await fail1(c); c.closeIssue = async () => { throw new Error("nope"); };
  assert.equal((await reportPass({ port: c, server: "production", hash: H1 })).stage, "close");
  assert.equal((await reportPass({ port: fakeIssues({ failAt: "find" }), server: "production", hash: H1 })).stage, "find");
});

// ---- the REST adapter ----
function fakeFetch(routes) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, ...init });
    const r = routes(url, init);
    return { ok: r.status < 400, status: r.status, json: async () => r.body };
  };
  fn.calls = calls;
  return fn;
}
const TOKEN = "ghs_SECRETTOKEN";

test("REST: findIssues filters PRs, sorts oldest first, validates state, token only in the header", async () => {
  const f = fakeFetch(() => ({ status: 200, body: [{ number: 9, title: "b", state: "open" }, { number: 3, title: "a", state: "open" }, { number: 4, title: "pr", pull_request: {}, state: "open" }] }));
  const port = createGithubPort({ repo: REPO, token: TOKEN, fetch: f });
  const found = await port.findIssues({ label: "adapter-watch", state: "open" });
  assert.deepEqual(found.issues.map((i) => i.number), [3, 9]);
  assert.equal(found.truncated, false);
  assert.match(f.calls[0].url, /\/repos\/campey\/workadventurer\/issues\?labels=adapter-watch&state=open/);
  assert.equal(f.calls[0].headers.authorization, `Bearer ${TOKEN}`);
  assert.ok(!f.calls[0].url.includes(TOKEN) && !String(f.calls[0].body ?? "").includes(TOKEN));
  await assert.rejects(port.findIssues({ label: "x", state: "bogus" }));
});

test("REST: create, update and close (comment then close)", async () => {
  const f = fakeFetch((url, init) => ({ status: init.method === "POST" && url.endsWith("/issues") ? 201 : 200, body: { number: 55, labels: [{ name: "adapter-watch" }] } }));
  const port = createGithubPort({ repo: REPO, token: TOKEN, fetch: f });
  assert.deepEqual(await port.createIssue({ title: "t", body: "b", labels: ["adapter-watch"] }), { number: 55, labels: ["adapter-watch"] });
  assert.deepEqual(JSON.parse(f.calls[0].body), { title: "t", body: "b", labels: ["adapter-watch"] });
  await port.updateIssue(55, { title: "t2", body: "b2" });
  assert.equal(f.calls[1].method, "PATCH");
  assert.ok(f.calls[1].url.endsWith("/issues/55"));
  await port.closeIssue(55, { comment: "done" });
  assert.deepEqual(f.calls.slice(2).map((c) => [c.method, c.url.split("/issues")[1]]), [["POST", "/55/comments"], ["PATCH", "/55"]]);
  assert.equal(JSON.parse(f.calls[3].body).state, "closed");
  await assert.rejects(port.closeIssue("55"));
});

test("REST: errors are scrubbed of the token", async () => {
  const f = fakeFetch(() => ({ status: 403, body: { message: `bad ${TOKEN} creds` } }));
  const port = createGithubPort({ repo: REPO, token: TOKEN, fetch: f });
  await assert.rejects(port.createIssue({ title: "t", body: "b" }), (e) => !e.message.includes(TOKEN) && /HTTP 403/.test(e.message));
  const r = await reportFailure({ port, server: "production", hash: H1, runUrl: RUN, gate: "x" });
  assert.equal(r.ok, false);
  assert.ok(!JSON.stringify(r).includes(TOKEN));
});

// ---- fix round 1 ----
const mentions = (text) => text.replace(/`[^`\n]*`/g, "").replace(/```[\s\S]*?```/g, "").match(/@[A-Za-z0-9_-]+/g);

test("I1: @octocat in version, waVersion and protoFamily never reaches prose (create, update, pass comment)", async () => {
  const port = fakeIssues();
  const evil = { version: "@octocat", candidate: { waVersion: "@octocat", protoFamily: "@octocat" } };
  await fail1(port, evil);
  await fail1(port, { ...evil, gate: "again" });
  await reportPass({ port, server: "production", hash: H1, version: "@octocat", runUrl: RUN });
  const i = port.issues[0];
  for (const text of [i.title, i.body, i.comments[0]]) {
    assert.equal(mentions(text), null, text);
    assert.ok(!text.includes("@octocat"));
  }
  assert.match(i.body, /`\(at\)octocat`/);
});

test("I1: the display form master@<hex> is kept, inside a code span", async () => {
  const port = fakeIssues();
  await reportFailure({ port, server: "staging", hash: H1, version: "master@118dd84c", gate: "x", candidate: { waVersion: "master-118dd84c" } });
  assert.ok(port.issues[0].body.includes("`master@118dd84c`"));
  assert.equal(mentions(port.issues[0].body), null);
});

test("I2: a dropped label is retried once; still missing -> ok with labelMissing", async () => {
  const a = fakeIssues({ dropLabels: true });
  const r1 = await fail1(a);
  assert.deepEqual([r1.ok, r1.labelMissing], [true, undefined]);
  assert.ok(a.calls.includes("addLabels") && a.issues[0].labels.includes("adapter-watch"));
  const b = fakeIssues({ dropLabels: true, dropAlways: true });
  const r2 = await fail1(b);
  assert.deepEqual([r2.ok, r2.labelMissing, r2.issue], [true, true, 101]);
});

test("I2: a labelless watcher issue is found by title and marker, not duplicated", async () => {
  const port = fakeIssues();
  await fail1(port);
  port.issues[0].labels = [];
  const r = await fail1(port, { gate: "again" });
  assert.deepEqual([r.action, r.issue], ["updated", 101]);
  assert.equal(port.issues.length, 1);
  assert.deepEqual(port.queries.at(-1), { label: undefined, state: "open" });
  assert.equal((await reportPass({ port, server: "production", hash: H1 })).closed[0], 101);
});

test("M2: lookalike issues without the watcher's marker are never adopted, updated or closed", async () => {
  const port = fakeIssues();
  port.issues.push({ number: 3, title: `Server v1 needs attention (adapter ${H1})`, body: "hi", labels: ["adapter-watch"], state: "open", comments: [] });
  port.issues.push({ number: 4, title: STAGING_TITLE, body: marker(H1), labels: ["adapter-watch"], state: "open", comments: [] });
  assert.equal((await fail1(port)).action, "created");
  assert.equal((await reportFailure({ port, server: "staging", hash: H2, gate: "x" })).action, "created");
  await reportPass({ port, server: "production", hash: H1 });
  assert.equal(port.issues[0].state, "open");
});

test("M1: truncation is signalled", async () => {
  const r = await fail1(fakeIssues({ truncated: true }));
  assert.equal(r.truncated, true);
  assert.equal((await reportPass({ port: fakeIssues({ truncated: true }), server: "production", hash: H1 })).truncated, true);
});

test("M1: REST findIssues pages and flags truncation at the cap", async () => {
  const page = (p) => Array.from({ length: 100 }, (_, k) => ({ number: p * 100 + k, title: "t", state: "open" }));
  const f = fakeFetch((url) => ({ status: 200, body: page(Number(url.match(/page=(\d+)/)[1])) }));
  const port = createGithubPort({ repo: REPO, token: TOKEN, fetch: f });
  const r = await port.findIssues({ state: "open" });
  assert.equal(f.calls.length, 5);
  assert.equal(r.issues.length, 500);
  assert.equal(r.truncated, true);
  assert.ok(!f.calls[0].url.includes("labels="));
  const short = fakeFetch(() => ({ status: 200, body: [{ number: 1, title: "t", state: "open" }] }));
  assert.equal((await createGithubPort({ repo: REPO, token: TOKEN, fetch: short }).findIssues({ label: "l" })).truncated, false);
});

test("M5: an unexpected throw is stage unexpected", async () => {
  const port = fakeIssues();
  const r = await fail1(port, { candidate: { get waVersion() { throw new Error("weird"); } } });
  assert.equal(r.stage, "unexpected");
});

test("REST: addLabels returns the applied labels", async () => {
  const f = fakeFetch(() => ({ status: 200, body: [{ name: "adapter-watch" }] }));
  const port = createGithubPort({ repo: REPO, token: TOKEN, fetch: f });
  assert.deepEqual(await port.addLabels(5, ["adapter-watch"]), { labels: ["adapter-watch"] });
  assert.ok(f.calls[0].url.endsWith("/issues/5/labels"));
});
