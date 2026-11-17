// Adapter watcher: the GitHub port (#127). The watcher reaches GitHub only through
// this object, so tests use a fake and the real REST adapter is swapped in by the
// workflow. Task 5 adds issue methods to the same port.
//
//   mainCommit()                          -> sha of the tip of the base branch
//   createBranch(name, sha)               -> create the branch, or reset it to `sha` if it exists
//   commit({ branch, message, files, parent }) -> { sha }: one commit of [{ path, content }] whose parent is
//                                         exactly `parent` (the sha given to createBranch); the branch is
//                                         force-moved to it
//   findOpenPr(branch)                    -> { number, headSha, headRepo } | null
//   openPr({ branch, title, body })       -> { number }
//   merge(number, { expectedHeadSha })    -> { merged: true } (throws or { merged:false } otherwise); GitHub
//                                         refuses (409) if the PR head is no longer expectedHeadSha
//   repo                                  -> "owner/name", so callers can check a PR's head repo
//   findIssues({ label?, state })         -> { issues: [{ number, title, state, body, author }], truncated }
//                                         oldest first, pull requests excluded; label optional; state is
//                                         open | closed | all; up to 5 pages of 100, truncated:true if more
//   createIssue({ title, body, labels })  -> { number, labels }: labels as GitHub actually applied them
//   addLabels(number, labels)             -> { labels }: the issue's labels afterwards
//   updateIssue(number, { title, body })  -> { number }
//   closeIssue(number, { comment })       -> { closed: true }: comments first (if given), then closes
//
// Every method may throw; callers (publish) turn that into a result object.
// The token is only ever sent in the Authorization header: it is never logged, and
// any text that reaches an error message is scrubbed of it first.

import path from "node:path";
import { HASH_RE } from "../../src/catalog/schema.mjs";

const MAX_PAGES = 5;

/** Refuse any path that is not a plain file path under catalog/ (the PR may touch nothing else). */
export function assertCatalogPaths(paths) {
  for (const p of paths) {
    const bad = typeof p !== "string" || p === "" || p.includes("\\") || p.includes("\0") || p.startsWith("/");
    const norm = bad ? null : path.posix.normalize(p);
    if (bad || norm !== p || !p.startsWith("catalog/") || p.split("/").includes("..") || p.endsWith("/")) {
      throw new Error(`refusing to publish "${String(p).slice(0, 80)}": only files under catalog/ may be published`);
    }
  }
}

/** The branch the watcher uses for a hash. Validates the hash before building the name. */
export function branchFor(hash) {
  if (typeof hash !== "string" || !HASH_RE.test(hash)) throw new Error(`invalid adapter hash "${String(hash).slice(0, 20)}"`);
  return `adapter/${hash}`;
}

/**
 * The real adapter: GitHub REST with a token and an injected fetch.
 * `repo` is "owner/name"; `base` is the protected branch PRs target.
 */
export function createGithubPort({ repo, token, fetch: fetchFn = globalThis.fetch, base = "main", apiUrl = "https://api.github.com" } = {}) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo ?? "")) throw new Error("createGithubPort: repo must be owner/name");
  if (!token) throw new Error("createGithubPort: a token is required");
  if (typeof fetchFn !== "function") throw new Error("createGithubPort: fetch is required");
  const scrub = (s) => String(s).split(token).join("***");

  async function api(method, route, body, { okStatuses = [] } = {}) {
    let res;
    try {
      res = await fetchFn(`${apiUrl}/repos/${repo}${route}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
          "user-agent": "workadventurer-adapter-watcher",
          ...(body ? { "content-type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      throw new Error(scrub(`${method} ${route}: ${e?.message ?? e}`));
    }
    let data = null;
    try { data = await res.json(); } catch { /* empty or non-JSON body */ }
    if (!res.ok && !okStatuses.includes(res.status)) {
      const msg = typeof data?.message === "string" ? data.message : "";
      throw new Error(scrub(`${method} ${route}: HTTP ${res.status} ${msg}`.trim()).slice(0, 300));
    }
    return { status: res.status, data };
  }

  const refRoute = (name) => `/git/ref/heads/${name.split("/").map(encodeURIComponent).join("/")}`;
  const updateRoute = (name) => `/git/refs/heads/${name.split("/").map(encodeURIComponent).join("/")}`;

  return {
    repo,
    async mainCommit() {
      const { data } = await api("GET", refRoute(base));
      return data.object.sha;
    },
    async createBranch(name, sha) {
      const made = await api("POST", "/git/refs", { ref: `refs/heads/${name}`, sha }, { okStatuses: [422] });
      if (made.status === 422) {
        // Only "already exists" means reset the branch; any other 422 (bad sha, bad name) is an error.
        if (!/reference already exists/i.test(String(made.data?.message ?? ""))) {
          throw new Error(scrub(`POST /git/refs: HTTP 422 ${made.data?.message ?? ""}`.trim()).slice(0, 300));
        }
        await api("PATCH", updateRoute(name), { sha, force: true });
      }
    },
    async commit({ branch, message, files, parent }) {
      assertCatalogPaths(files.map((f) => f.path));
      if (!/^[0-9a-f]{40}$/.test(parent ?? "")) throw new Error("commit needs the parent sha the branch was cut from");
      const base = (await api("GET", `/git/commits/${parent}`)).data;
      const tree = (await api("POST", "/git/trees", {
        base_tree: base.tree.sha,
        tree: files.map((f) => ({ path: f.path, mode: "100644", type: "blob", content: f.content })),
      })).data;
      const made = (await api("POST", "/git/commits", { message, tree: tree.sha, parents: [parent] })).data;
      await api("PATCH", updateRoute(branch), { sha: made.sha, force: true });
      return { sha: made.sha };
    },
    async findOpenPr(branch) {
      const owner = repo.split("/")[0];
      const { data } = await api("GET", `/pulls?state=open&head=${encodeURIComponent(`${owner}:${branch}`)}&base=${encodeURIComponent(base)}`);
      if (!Array.isArray(data) || !data.length) return null;
      const pr = data[0];
      return { number: pr.number, headSha: pr.head?.sha, headRepo: pr.head?.repo?.full_name };
    },
    async openPr({ branch, title, body }) {
      const { data } = await api("POST", "/pulls", { title, body, head: branch, base });
      return { number: data.number };
    },
    async merge(number, { expectedHeadSha } = {}) {
      if (!expectedHeadSha) throw new Error("merge needs expectedHeadSha");
      const { data } = await api("PUT", `/pulls/${number}/merge`, { merge_method: "squash", sha: expectedHeadSha });
      return { merged: data?.merged === true };
    },
    async findIssues({ label, state = "open" } = {}) {
      if (label != null && (typeof label !== "string" || !label)) throw new Error("findIssues: label must be a non-empty string");
      if (!["open", "closed", "all"].includes(state)) throw new Error("findIssues: state must be open, closed or all");
      const issues = [];
      let truncated = false;
      for (let page = 1; page <= MAX_PAGES; page++) {
        const q = `${label ? `labels=${encodeURIComponent(label)}&` : ""}state=${state}&per_page=100&page=${page}&sort=created&direction=asc`;
        const { data } = await api("GET", `/issues?${q}`);
        if (!Array.isArray(data)) break;
        for (const i of data) {
          if (i.pull_request) continue;
          issues.push({ number: i.number, title: String(i.title ?? ""), state: i.state, body: String(i.body ?? ""), author: i.user?.login ?? null });
        }
        if (data.length < 100) break;
        if (page === MAX_PAGES) truncated = true;
      }
      issues.sort((x, y) => x.number - y.number);
      return { issues, truncated };
    },
    async createIssue({ title, body, labels = [] }) {
      const { data } = await api("POST", "/issues", { title, body, labels });
      return { number: data.number, labels: (data.labels ?? []).map((l) => (typeof l === "string" ? l : l?.name)) };
    },
    async addLabels(number, labels) {
      if (!Number.isInteger(number)) throw new Error("addLabels needs an issue number");
      const { data } = await api("POST", `/issues/${number}/labels`, { labels });
      return { labels: (Array.isArray(data) ? data : []).map((l) => (typeof l === "string" ? l : l?.name)) };
    },
    async updateIssue(number, { title, body }) {
      if (!Number.isInteger(number)) throw new Error("updateIssue needs an issue number");
      const { data } = await api("PATCH", `/issues/${number}`, { ...(title !== undefined ? { title } : {}), ...(body !== undefined ? { body } : {}) });
      return { number: data.number };
    },
    async closeIssue(number, { comment } = {}) {
      if (!Number.isInteger(number)) throw new Error("closeIssue needs an issue number");
      if (comment) await api("POST", `/issues/${number}/comments`, { body: comment });
      await api("PATCH", `/issues/${number}`, { state: "closed", state_reason: "completed" });
      return { closed: true };
    },
  };
}
