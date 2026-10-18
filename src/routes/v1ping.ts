import type { FastifyInstance } from "fastify";
import { apiKeyAuth, withScope } from "../middleware/auth.js";

/**
 * Connectivity/auth check for integrations (mirrors Stripe's "retrieve
 * balance" smoke test pattern): proves a secret is valid, shows its scope
 * and mode, without touching billing or providers.
 */
export async function v1PingRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    "/v1/ping",
    { preHandler: [apiKeyAuth, withScope("generations:read")] },
    async (req, reply) => {
      const ctx = req.apiAuth!;
      return reply.send({
        ok: true,
        account_id: ctx.accountId,
        key_id: ctx.key.id,
        key_mode: ctx.key.mode,
        scopes: ctx.key.scopes,
        plan_id: ctx.planId,
      });
    },
  );
}
