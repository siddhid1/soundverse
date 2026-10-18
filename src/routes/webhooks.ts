import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getEnv } from "../config/env.js";
import { getPool } from "../db/index.js";
import { buildError } from "../lib/errors.js";
import { requestIdFor } from "../lib/request.js";
import { sendServiceError } from "../lib/serviceErrors.js";
import { apiKeyAuth, withScope } from "../middleware/auth.js";
import { fail } from "../services/generations.js";
import { decryptSecret, encryptSecret, generateSigningSecret } from "../webhooks/crypto.js";
import { assertUrlAllowed, SsrfError } from "../webhooks/ssrf.js";

const registerSchema = z.object({
  url: z.string().min(1).max(2048),
  enabled: z.boolean().optional().default(true),
});

export interface EndpointView {
  id: string;
  url: string;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

function toView(row: Record<string, unknown>): EndpointView {
  return {
    id: row.id as string,
    url: row.url as string,
    enabled: row.enabled as boolean,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  };
}

function ssrfToFailure(err: SsrfError): never {
  const code =
    err.reason === "blocked_address" || err.reason === "http_not_allowed"
      ? "webhook_url_blocked"
      : "webhook_url_invalid";
  throw fail(code, err.message);
}

export async function webhookRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", apiKeyAuth);

  app.post(
    "/v1/webhook_endpoints",
    { preHandler: withScope("generations:write") },
    async (req, reply) => {
      const parsed = registerSchema.safeParse(req.body);
      if (!parsed.success) {
        const requestId = requestIdFor(req);
        return reply
          .code(400)
          .send(buildError("validation_error", "validation_failed", "Invalid webhook endpoint payload.", requestId));
      }
      const env = getEnv();
      try {
        const checked = await assertUrlAllowed(parsed.data.url, {
          allowPrivate: env.WEBHOOK_ALLOW_PRIVATE_IPS,
        }).catch((e: unknown) => {
          if (e instanceof SsrfError) ssrfToFailure(e);
          throw e;
        });
        const secret = generateSigningSecret();
        const res = await getPool().query(
          `INSERT INTO webhook_endpoints(id, account_id, url, secret_enc, enabled)
           VALUES (gen_random_uuid(), $1, $2, $3, $4)
           RETURNING id, url, enabled, created_at, updated_at`,
          [req.apiAuth!.accountId, checked.url, encryptSecret(secret, env.WEBHOOK_CRYPT_KEY), parsed.data.enabled],
        );
        // Signing secret leaves the server exactly once, in this response.
        return reply.code(201).send({ ...toView(res.rows[0] as Record<string, unknown>), signing_secret: secret });
      } catch (err) {
        sendServiceError(reply, err);
      }
    },
  );

  app.get("/v1/webhook_endpoints", { preHandler: withScope("generations:read") }, async (req, reply) => {
    const res = await getPool().query(
      `SELECT id, url, enabled, created_at, updated_at FROM webhook_endpoints
       WHERE account_id=$1 ORDER BY created_at DESC`,
      [req.apiAuth!.accountId],
    );
    return reply.send({ endpoints: (res.rows as Record<string, unknown>[]).map(toView) });
  });

  app.delete(
    "/v1/webhook_endpoints/:id",
    { preHandler: withScope("generations:write") },
    async (req, reply) => {
      const res = await getPool().query(
        `DELETE FROM webhook_endpoints WHERE id=$1 AND account_id=$2 RETURNING id`,
        [(req.params as { id: string }).id, req.apiAuth!.accountId],
      );
      if ((res.rowCount ?? 0) === 0) {
        const requestId = requestIdFor(req);
        return reply
          .code(404)
          .send(buildError("not_found_error", "not_found", "Webhook endpoint not found.", requestId));
      }
      return reply.send({ deleted: true });
    },
  );
}

/** Test/support helper: decrypt an endpoint secret (never exposed via API). */
export async function decryptEndpointSecret(endpointId: string, accountId: string): Promise<string> {
  const res = await getPool().query(`SELECT secret_enc FROM webhook_endpoints WHERE id=$1 AND account_id=$2`, [
    endpointId,
    accountId,
  ]);
  if ((res.rowCount ?? 0) === 0) throw fail("not_found", "Webhook endpoint not found.");
  return decryptSecret((res.rows[0] as { secret_enc: string }).secret_enc, getEnv().WEBHOOK_CRYPT_KEY);
}
