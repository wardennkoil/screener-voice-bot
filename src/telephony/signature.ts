import { createHmac, timingSafeEqual } from "node:crypto";
import twilio from "twilio";
import type { FastifyRequest } from "fastify";

export interface SessionTokenPayload {
  contactId: string;
  phone: string;
  firstName: string;
  attempt: number;
  /** Unix seconds. */
  exp: number;
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

function sign(secret: string, body: string): string {
  return createHmac("sha256", secret).update(body).digest("base64url");
}

/** Signs the per-call contact details so TwiML and WebSocket requests cannot be forged. */
export function makeSessionToken(secret: string, payload: Omit<SessionTokenPayload, "exp">, ttlSeconds = 2 * 60 * 60): string {
  const full: SessionTokenPayload = { ...payload, exp: Math.floor(Date.now() / 1000) + ttlSeconds };
  const body = b64url(JSON.stringify(full));
  return `${body}.${sign(secret, body)}`;
}

export function verifySessionToken(secret: string, token: string | undefined): SessionTokenPayload | null {
  if (!token) return null;
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const expected = sign(secret, body);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as SessionTokenPayload;
    if (typeof payload.exp !== "number" || payload.exp < Math.floor(Date.now() / 1000)) return null;
    if (typeof payload.contactId !== "string" || typeof payload.phone !== "string" || typeof payload.firstName !== "string") return null;
    return { ...payload, attempt: typeof payload.attempt === "number" ? payload.attempt : 1 };
  } catch {
    return null;
  }
}

/** Validates X-Twilio-Signature on a webhook using the public URL Twilio actually requested. */
export function isValidTwilioRequest(req: FastifyRequest, authToken: string, publicHost: string): boolean {
  const header = req.headers["x-twilio-signature"];
  const signature = Array.isArray(header) ? header[0] : header;
  if (!signature) return false;
  const url = `https://${publicHost}${req.url}`;
  const params = req.method === "POST" && req.body && typeof req.body === "object" ? (req.body as Record<string, string>) : {};
  return twilio.validateRequest(authToken, signature, url, params);
}

export interface WebhookAuth {
  authToken: string;
  publicHost: string;
  accountSid: string;
  sessionTokenSecret: string;
}

export type WebhookVerdict = { ok: true; via: "signature" | "token"; payload: SessionTokenPayload | null } | { ok: false; reason: string };

/**
 * Authorizes a Twilio webhook. A signed request must carry a valid signature.
 * Some Twilio requests arrive unsigned (observed on trial accounts for the TwiML
 * fetch); those are accepted only when the URL carries a valid signed session
 * token, which only Twilio has seen, and the body names our own account.
 */
export function authorizeTwilioWebhook(req: FastifyRequest, auth: WebhookAuth): WebhookVerdict {
  const query = (req.query ?? {}) as Record<string, unknown>;
  const token = typeof query.token === "string" ? query.token : undefined;
  const payload = verifySessionToken(auth.sessionTokenSecret, token);
  const header = req.headers["x-twilio-signature"];
  const signature = Array.isArray(header) ? header[0] : header;
  if (signature) {
    return isValidTwilioRequest(req, auth.authToken, auth.publicHost) ? { ok: true, via: "signature", payload } : { ok: false, reason: "invalid X-Twilio-Signature" };
  }
  if (!payload) return { ok: false, reason: "unsigned request without a valid session token" };
  const body = (req.body ?? {}) as Record<string, unknown>;
  if (body.AccountSid !== auth.accountSid) return { ok: false, reason: "unsigned request for a different AccountSid" };
  return { ok: true, via: "token", payload };
}
