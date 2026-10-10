// WebSocket that goes through an HTTPS egress proxy when one is configured.
//
// `ws` opens its own TLS socket and ignores HTTPS_PROXY, so behind a proxy
// (Claude Code cloud sessions, corporate networks) the pusher socket fails
// with ENOTFOUND. Give it Node's proxy-aware agent instead. Node's fetch needs
// NODE_USE_ENV_PROXY=1 (Node >= 22.21) for the HTTP half; see
// docs/fakes-with-probes.md. Without HTTPS_PROXY this is plain `ws`.
import https from "node:https";
import WebSocket from "ws";

const proxied = !!(process.env.HTTPS_PROXY || process.env.https_proxy);
let agent = null;

export class ProxiedWebSocket extends WebSocket {
  constructor(url, protocols, opts = {}) {
    if (proxied && !opts.agent) {
      agent ??= new https.Agent({ proxyEnv: process.env });
      opts = { ...opts, agent };
    }
    super(url, protocols, opts);
  }
}

/** The WebSocket class to hand WorkAdventureClient: proxied when HTTPS_PROXY is set. */
export const DefaultWebSocket = proxied ? ProxiedWebSocket : WebSocket;
