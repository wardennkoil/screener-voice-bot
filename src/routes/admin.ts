import type { FastifyInstance } from "fastify";
import { adminPageHtml } from "../admin/page.js";
import { isAnalysisCurrent } from "../analytics/analyze.js";
import { buildOverview, bundle, summarize, type CallBundle } from "../analytics/overview.js";
import type { AnalysisService } from "../analytics/service.js";
import { displayTurns } from "../analytics/stats.js";
import { flattenQuestions, type Questionnaire } from "../screening/schema.js";
import type { AnalyticsStore, ResultSource } from "../storage/store.js";
import { guardScope } from "./access.js";

export interface AdminDeps {
  store: AnalyticsStore;
  service: AnalysisService;
}

export async function registerAdminRoutes(app: FastifyInstance, deps: AdminDeps & { questionnaire: Questionnaire; accessToken?: string; openAccess?: boolean; localEnabled?: boolean }): Promise<void> {
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
    guardScope(scope, deps.accessToken, ["/admin"], deps.openAccess);

    scope.get("/admin", async (_req, reply) =>
      reply.type("text/html").header("content-security-policy", "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src 'self' data:").send(
        adminPageHtml({ studyName: questionnaire.study.name, persona: questionnaire.caller.persona_name, model: service.model, localEnabled: deps.localEnabled }),
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
        analysis: b.analysis ? { ...b.analysis, stale: !isAnalysisCurrent(b.analysis, t) } : null,
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

    scope.get("/admin/api/results.csv", async (req, reply) => {
      const source: ResultSource = (req.query as { source?: string }).source === "phone" ? "phone" : "local";
      const csv = await store.resultsCsv(questionnaire, source);
      return reply
        .type("text/csv; charset=utf-8")
        .header("content-disposition", `attachment; filename="screening-results-${source === "local" ? "laptop" : "phone"}.csv"`)
        .send(csv);
    });
  });
}
