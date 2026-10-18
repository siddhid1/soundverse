import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getPool } from "../db/index.js";
import { buildError } from "../lib/errors.js";
import { requestIdFor } from "../lib/request.js";
import { sendServiceError } from "../lib/serviceErrors.js";
import { sessionAuth } from "../middleware/auth.js";
import {
  createApiKey,
  getApiKey,
  listApiKeys,
  revokeApiKey,
  rotateApiKey,
} from "../services/apiKeys.js";
import { listAudit } from "../services/audit.js";

const createSchema = z.object({
  name: z.string().min(1).max(80).optional(),
  scopes: z.array(z.enum(["generations:write", "generations:read"])).min(1).max(10),
  mode: z.enum(["test", "live"]),
});

const rotateSchema = z.object({
  name: z.string().min(1).max(80).optional(),
});

export async function keyRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", sessionAuth);

  app.post("/keys", async (req, reply) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      const requestId = requestIdFor(req);
      return reply
        .code(400)
        .send(buildError("validation_error", "validation_failed", "Invalid key payload.", requestId));
    }
    try {
      const { key, secret } = await createApiKey(getPool(), {
        accountId: req.sessionAuth!.account.id,
        createdByUserId: req.sessionAuth!.user.id,
        name: parsed.data.name,
        scopes: parsed.data.scopes,
        mode: parsed.data.mode,
      });
      // Full secret leaves the server exactly once, in this response.
      return reply.code(201).send({ ...key, secret });
    } catch (err) {
      sendServiceError(reply, err);
    }
  });

  app.get("/keys", async (req, reply) => {
    const keys = await listApiKeys(getPool(), req.sessionAuth!.account.id);
    return reply.send({ keys });
  });

  app.get("/keys/:id", async (req, reply) => {
    const key = await getApiKey(getPool(), req.sessionAuth!.account.id, (req.params as { id: string }).id);
    if (!key) {
      const requestId = requestIdFor(req);
      return reply
        .code(404)
        .send(buildError("not_found_error", "key_not_found", "API key not found.", requestId));
    }
    return reply.send({ key });
  });

  app.post("/keys/:id/revoke", async (req, reply) => {
    try {
      const key = await revokeApiKey(getPool(), {
        accountId: req.sessionAuth!.account.id,
        keyId: (req.params as { id: string }).id,
        actorUserId: req.sessionAuth!.user.id,
      });
      return reply.send({ key });
    } catch (err) {
      sendServiceError(reply, err);
    }
  });

  app.post("/keys/:id/rotate", async (req, reply) => {
    const parsed = rotateSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      const requestId = requestIdFor(req);
      return reply
        .code(400)
        .send(buildError("validation_error", "validation_failed", "Invalid rotate payload.", requestId));
    }
    try {
      const { key, secret } = await rotateApiKey(getPool(), {
        accountId: req.sessionAuth!.account.id,
        keyId: (req.params as { id: string }).id,
        actorUserId: req.sessionAuth!.user.id,
        name: parsed.data.name,
      });
      return reply.code(201).send({ ...key, secret });
    } catch (err) {
      sendServiceError(reply, err);
    }
  });

  app.get("/audit-log", async (req, reply) => {
    const entries = await listAudit(getPool(), req.sessionAuth!.account.id);
    return reply.send({ entries });
  });
}
