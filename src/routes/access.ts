import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

/**
 * One access rule for everything that shows call data or spends API credits (/admin, /local).
 * With ADMIN_TOKEN set: a Bearer header or the cookie set by visiting a page once with ?token=.
 * Without it: direct localhost requests only (tunnels add x-forwarded-for, and a localhost Host
 * header stops DNS-rebinding pages). Cross-origin writes are refused either way.
 */

const COOKIE = "screener_token";
const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

function hostname(host: string | undefined): string {
  return (host ?? "").toLowerCase().replace(/:\d+$/, "");
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function cookieValue(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return undefined;
}

export function isAuthorized(req: FastifyRequest, token: string | undefined): boolean {
  if (token) {
    const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1];
    const presented = bearer ?? cookieValue(req.headers.cookie, COOKIE);
    return presented !== undefined && safeEqual(presented, token);
  }
  const direct = !req.headers["x-forwarded-for"] && !req.headers.forwarded;
  // No socket (some injected upgrade requests) means no proof of a local caller: refuse.
  return direct && LOOPBACK.has(req.socket?.remoteAddress ?? "") && LOCAL_HOSTNAMES.has(hostname(req.headers.host));
}

/** Browsers send Origin on cross-site POSTs; refuse any that did not come from this app. */
export function isSameOrigin(req: FastifyRequest): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    // req.host honours X-Forwarded-Host behind a proxy (trustProxy), which is what the browser's Origin names.
    return new URL(origin).host.toLowerCase() === req.host.toLowerCase();
  } catch {
    return false;
  }
}

function deny(reply: FastifyReply, token: string | undefined): FastifyReply {
  const hint = token
    ? "Open /admin?token=<ADMIN_TOKEN> once, or send Authorization: Bearer <ADMIN_TOKEN>."
    : "This page only answers on localhost. Set ADMIN_TOKEN to open it through a tunnel or from another machine.";
  return reply.code(401).type("text/plain").send(`Unauthorized. ${hint}`);
}

/**
 * Guards every route registered in `scope`. `pages` are the paths where a one-time ?token= login
 * is accepted: it is traded for an HttpOnly cookie covering the whole app, then dropped from the URL.
 * With `open` (OPEN_ACCESS) anyone may use them; cross-origin writes are still refused.
 */
export function guardScope(scope: FastifyInstance, token: string | undefined, pages: string[], open = false): void {
  scope.addHook("onRequest", async (req, reply) => {
    if (open) {
      if (req.method !== "GET" && req.method !== "HEAD" && !isSameOrigin(req)) return reply.code(403).type("text/plain").send("Cross-origin request refused.");
      reply.header("cache-control", "no-store");
      return;
    }
    const path = req.url.split("?")[0]!;
    const query = req.query as { token?: unknown } | undefined;
    if (token && req.method === "GET" && pages.includes(path) && typeof query?.token === "string") {
      if (!safeEqual(query.token, token)) return deny(reply, token);
      const secure = req.protocol === "https" ? "; Secure" : "";
      return reply.header("set-cookie", `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000${secure}`).redirect(path);
    }
    if (!isAuthorized(req, token)) return deny(reply, token);
    if (req.method !== "GET" && req.method !== "HEAD" && !isSameOrigin(req)) return reply.code(403).type("text/plain").send("Cross-origin request refused.");
    reply.header("cache-control", "no-store");
  });
}
