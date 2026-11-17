// Adapter watcher: the GitHub port (#127). The watcher reaches GitHub only through
// this object, so tests use a fake and the real REST adapter is swapped in by the
// workflow. Task 5 adds issue methods to the same port.
//
//   mainCommit()                          -> sha of the tip of the base branch
//   createBranch(name, sha)               -> create the branch, or reset it to `sha` if it exists
//   commit({ branch, message, files })    -> one commit of [{ path, content }] on the branch
//   findOpenPr(branch)                    -> { number } | null
//   openPr({ branch, title, body })       -> { number }
//   merge(number)                         -> { merged: true } (throws or { merged:false } otherwise)
//
// Every method may throw; callers (publish) turn that into a result object.
// The token is only ever sent in the Authorization header: it is never logged, and
// any text that reaches an error message is scrubbed of it first.

import path from "node:path";
import { HASH_RE } from "../../src/catalog/schema.mjs";

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
      throw new Error(scrub(`${method} ${route}: HTTP ${res.status} ${msg}`.trim().slice(0, 300)));
    }
    return { status: res.status, data };
  }

  const refRoute = (name) => `/git/ref/heads/${name.split("/").map(encodeURIComponent).join("/")}`;
  const updateRoute = (name) => `/git/refs/heads/${name.split("/").map(encodeURIComponent).join("/")}`;

  return {
    async mainCommit() {
      const { data } = await api("GET", refRoute(base));
      return data.object.sha;
    },
    async createBranch(name, sha) {
      const made = await api("POST", "/git/refs", { ref: `refs/heads/${name}`, sha }, { okStatuses: [422] });
      if (made.status === 422) await api("PATCH", updateRoute(name), { sha, force: true });
    },
    async commit({ branch, message, files }) {
      assertCatalogPaths(files.map((f) => f.path));
      const head = (await api("GET", refRoute(branch))).data.object.sha;
      const parent = (await api("GET", `/git/commits/${head}`)).data;
      const tree = (await api("POST", "/git/trees", {
        base_tree: parent.tree.sha,
        tree: files.map((f) => ({ path: f.path, mode: "100644", type: "blob", content: f.content })),
      })).data;
      const made = (await api("POST", "/git/commits", { message, tree: tree.sha, parents: [head] })).data;
      await api("PATCH", updateRoute(branch), { sha: made.sha });
      return { sha: made.sha };
    },
    async findOpenPr(branch) {
      const owner = repo.split("/")[0];
      const { data } = await api("GET", `/pulls?state=open&head=${encodeURIComponent(`${owner}:${branch}`)}&base=${encodeURIComponent(base)}`);
      return Array.isArray(data) && data.length ? { number: data[0].number } : null;
    },
    async openPr({ branch, title, body }) {
      const { data } = await api("POST", "/pulls", { title, body, head: branch, base });
      return { number: data.number };
    },
    async merge(number) {
      const { data } = await api("PUT", `/pulls/${number}/merge`, { merge_method: "squash" });
      return { merged: data?.merged === true };
    },
  };
}
