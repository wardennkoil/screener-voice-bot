import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { adminPageHtml } from "../admin/page.js";
import { transcriptHash } from "../analytics/analyze.js";
import { buildOverview, bundle, summarize, type CallBundle } from "../analytics/overview.js";
import type { AnalysisService } from "../analytics/service.js";
import { displayTurns } from "../analytics/stats.js";
import type { AnalyticsStore } from "../analytics/store.js";
import { flattenQuestions, type Questionnaire } from "../screening/schema.js";

export interface AdminDeps {
  store: AnalyticsStore;
  service: AnalysisService;
  /** When unset the panel only answers direct localhost requests. */
  token?: string;
}

const COOKIE = "admin_token";
const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

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

/** Transcripts hold health answers: token when configured, otherwise loopback only (tunnels add x-forwarded-for). */
export function isAuthorized(req: FastifyRequest, token: string | undefined): boolean {
  if (token) {
    const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1];
    const presented = bearer ?? cookieValue(req.headers.cookie, COOKIE);
    return presented !== undefined && safeEqual(presented, token);
  }
  const direct = !req.headers["x-forwarded-for"] && !req.headers.forwarded;
  return direct && LOOPBACK.has(req.socket.remoteAddress ?? "");
}

function deny(reply: FastifyReply, token: string | undefined): FastifyReply {
  const hint = token
    ? "Open /admin?token=<ADMIN_TOKEN> once, or send Authorization: Bearer <ADMIN_TOKEN>."
    : "The admin panel only answers on localhost. Set ADMIN_TOKEN in .env to open it through a tunnel or from another machine.";
  return reply.code(401).type("text/plain").send(`Unauthorized. ${hint}`);
}

export async function registerAdminRoutes(app: FastifyInstance, deps: AdminDeps & { questionnaire: Questionnaire }): Promise<void> {
  const { store, service, questionnaire } = deps;

  const loadBundle = async (sid: string): Promise<CallBundle | undefined> => {
    const t = await store.transcript(sid);
    return t ? bundle(sid, t, questionnaire, await store.analysis(sid)) : undefined;
  };
  const loadAll = async (): Promise<CallBundle[]> => {
    const ts = await store.listTranscripts();
    return Promise.all(ts.map(async (t) => bundle(service.sidOf(t), t, questionnaire, await store.analysis(service.sidOf(t)))));
  };

  await app.register(async (scope) => {
    scope.addHook("onRequest", async (req, reply) => {
      const query = req.query as { token?: string } | undefined;
      // One-time login link: trade ?token= for an HttpOnly cookie and drop it from the URL.
      if (deps.token && req.method === "GET" && req.url.split("?")[0] === "/admin" && query?.token) {
        if (!safeEqual(query.token, deps.token)) return deny(reply, deps.token);
        const secure = req.protocol === "https" ? "; Secure" : "";
        return reply
          .header("set-cookie", `${COOKIE}=${encodeURIComponent(deps.token)}; Path=/admin; HttpOnly; SameSite=Strict; Max-Age=2592000${secure}`)
          .redirect("/admin");
      }
      if (!isAuthorized(req, deps.token)) return deny(reply, deps.token);
      reply.header("cache-control", "no-store");
    });

    scope.get("/admin", async (_req, reply) =>
      reply.type("text/html").header("content-security-policy", "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src 'self' data:").send(
        adminPageHtml({ studyName: questionnaire.study.name, persona: questionnaire.caller.persona_name, model: service.model }),
      ),
    );

    scope.get("/admin/api/calls", async () => {
      const bundles = await loadAll();
      return {
        calls: bundles.map((b) => ({ ...summarize(b), analysisStatus: service.status(b.sid, b.transcript, b.analysis).status })),
      };
    });

    scope.get("/admin/api/calls/:sid", async (req, reply) => {
      const { sid } = req.params as { sid: string };
      const b = await loadBundle(sid);
      if (!b) return reply.code(404).send({ error: "call not found" });
      const status = service.status(sid, b.transcript, b.analysis);
      const t = b.transcript;
      return {
        sid,
        startedAt: t.startedAt,
        endedAt: t.endedAt,
        outcome: t.outcome ?? "unknown",
        eligible: t.eligible ?? "undetermined",
        notes: t.notes,
        turns: displayTurns(t),
        toolCalls: t.toolCalls,
        stats: b.stats,
        plan: flattenQuestions(questionnaire).map((x) => ({ id: x.id, ask: x.ask, followUp: Boolean(x.parentId), required: x.required })),
        analysis: b.analysis ? { ...b.analysis, stale: b.analysis.transcriptHash !== transcriptHash(t) } : null,
        analysisStatus: status.status,
        analysisError: status.error,
      };
    });

    scope.post("/admin/api/calls/:sid/analyze", async (req, reply) => {
      const { sid } = req.params as { sid: string };
      if (!(await store.transcript(sid))) return reply.code(404).send({ error: "call not found" });
      service.enqueue(sid);
      return reply.code(202).send({ queued: true });
    });

    scope.post("/admin/api/analyze-pending", async (_req, reply) => reply.code(202).send({ queued: await service.analyzeAllPending() }));

    scope.get("/admin/api/overview", async () => buildOverview(await loadAll(), questionnaire));
  });
}
