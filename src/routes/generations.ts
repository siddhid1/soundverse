import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { getEnv } from "../config/env.js";
import { getPool } from "../db/index.js";
import { buildError } from "../lib/errors.js";
import { setRateLimitHeaders } from "../lib/request.js";
import { requestIdFor } from "../lib/request.js";
import { sendServiceError } from "../lib/serviceErrors.js";
import { apiKeyAuth, withScope } from "../middleware/auth.js";
import { generationInputSchema, generationStatusFilter } from "../services/credits.js";
import {
  cancelGeneration,
  createGeneration,
  getGenerationById,
  getPlan,
  listGenerations,
  readRateCounters,
  toPublicJob,
  usageSummary,
  type GenerationRow,
  type RateCounts,
} from "../services/generations.js";
import { accountIdFromAudioKey } from "../storage/store.js";
import { s3StoreFromEnv } from "../storage/s3.js";

const listQuerySchema = z.object({
  status: generationStatusFilter.optional(),
  limit: z.coerce.number().int().min(1).max(100).optional().default(20),
  offset: z.coerce.number().int().min(0).optional().default(0),
});

async function withAudioUrl(row: GenerationRow): Promise<Record<string, unknown>> {
  const job = toPublicJob(row);
  if (row.status === "succeeded" && row.object_key) {
    // Defense in depth: the SQL already scoped this row to the caller's
    // account, but the signed URL must never escape the tenant boundary, so
    // re-verify the scope embedded in the storage key itself.
    if (accountIdFromAudioKey(row.object_key) !== row.account_id) {
      throw new Error("Storage key scope mismatch.");
    }
    const url = await s3StoreFromEnv().presignedGet(row.object_key, getEnv().AUDIO_URL_TTL_SEC);
    job.output = { audio_url: url, duration_sec: row.output_duration_sec, format: row.output_format };
  }
  return job;
}

async function applyRateHeaders(
  reply: FastifyReply,
  accountId: string,
  planId: string,
  rate: RateCounts,
): Promise<void> {
  const plan = await getPlan(getPool(), planId);
  setRateLimitHeaders(reply, {
    limitHour: plan.requestsPerHour,
    remainingHour: Math.max(0, plan.requestsPerHour - rate.hour),
    limitDay: plan.requestsPerDay,
    remainingDay: Math.max(0, plan.requestsPerDay - rate.day),
  });
}

export async function generationRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", apiKeyAuth);

  app.post(
    "/v1/generations",
    { preHandler: withScope("generations:write") },
    async (req, reply) => {
      const parsed = generationInputSchema.safeParse(req.body);
      if (!parsed.success) {
        const requestId = requestIdFor(req);
        return reply
          .code(400)
          .send(buildError("validation_error", "validation_failed", "Invalid generation payload.", requestId));
      }
      const idempotencyKey = req.headers["idempotency-key"] as string | undefined;
      try {
        const result = await createGeneration(getPool(), {
          auth: req.apiAuth!,
          idempotencyKey,
          input: parsed.data,
        });
        await applyRateHeaders(reply, req.apiAuth!.accountId, req.apiAuth!.planId, result.rate);
        if (result.replayed) {
          void reply.header("Idempotent-Replayed", "true");
          return reply.code(200).send({ ...(await withAudioUrl(result.job)), idempotent_replayed: true });
        }
        return reply.code(202).send(await withAudioUrl(result.job));
      } catch (err) {
        // Rate headers on rejections too, so clients can back off correctly.
        try {
          const rate = await readRateCounters(getPool(), req.apiAuth!.accountId);
          await applyRateHeaders(reply, req.apiAuth!.accountId, req.apiAuth!.planId, rate);
        } catch {
          // Headers are best-effort; the error body is what matters.
        }
        sendServiceError(reply, err);
      }
    },
  );

  app.get("/v1/generations", { preHandler: withScope("generations:read") }, async (req, reply) => {
    const parsed = listQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      const requestId = requestIdFor(req);
      return reply
        .code(400)
        .send(buildError("validation_error", "validation_failed", "Invalid list query.", requestId));
    }
    const result = await listGenerations(getPool(), {
      accountId: req.apiAuth!.accountId,
      status: parsed.data.status,
      limit: parsed.data.limit,
      offset: parsed.data.offset,
    });
    const rate = await readRateCounters(getPool(), req.apiAuth!.accountId);
    await applyRateHeaders(reply, req.apiAuth!.accountId, req.apiAuth!.planId, rate);
    return reply.send({
      data: await Promise.all(result.data.map(withAudioUrl)),
      pagination: { limit: parsed.data.limit, offset: parsed.data.offset, total: result.total },
    });
  });

  app.get("/v1/generations/:id", { preHandler: withScope("generations:read") }, async (req, reply) => {
    try {
      const job = await getGenerationById(getPool(), req.apiAuth!.accountId, (req.params as { id: string }).id);
      const rate = await readRateCounters(getPool(), req.apiAuth!.accountId);
      await applyRateHeaders(reply, req.apiAuth!.accountId, req.apiAuth!.planId, rate);
      return reply.send(await withAudioUrl(job));
    } catch (err) {
      sendServiceError(reply, err);
    }
  });

  app.post(
    "/v1/generations/:id/cancel",
    { preHandler: withScope("generations:write") },
    async (req, reply) => {
      try {
        const result = await cancelGeneration(getPool(), {
          auth: req.apiAuth!,
          id: (req.params as { id: string }).id,
        });
        return reply.send({ ...(await withAudioUrl(result.job)), already_canceled: result.wasAlreadyCanceled || undefined });
      } catch (err) {
        sendServiceError(reply, err);
      }
    },
  );

  app.get("/v1/usage", { preHandler: withScope("generations:read") }, async (req, reply) => {
    const summary = await usageSummary(getPool(), {
      accountId: req.apiAuth!.accountId,
      planId: req.apiAuth!.planId,
    });
    const rate = await readRateCounters(getPool(), req.apiAuth!.accountId);
    await applyRateHeaders(reply, req.apiAuth!.accountId, req.apiAuth!.planId, rate);
    return reply.send(summary);
  });
}
