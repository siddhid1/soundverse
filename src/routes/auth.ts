import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getEnv } from "../config/env.js";
import { getPool } from "../db/index.js";
import { buildError } from "../lib/errors.js";
import { requestIdFor } from "../lib/request.js";
import { sendServiceError } from "../lib/serviceErrors.js";
import { SESSION_COOKIE, login, logout, resolveSession, signup, verifyEmail } from "../services/auth.js";

const signupSchema = z.object({
  email: z.string().email().max(254),
  password: z.string().min(12).max(200),
});

const loginSchema = z.object({
  email: z.string().email().max(254),
  password: z.string().min(1).max(200),
});

export async function authRoutes(app: FastifyInstance): Promise<void> {
  const env = getEnv();

  app.post("/auth/signup", async (req, reply) => {
    const parsed = signupSchema.safeParse(req.body);
    if (!parsed.success) {
      const requestId = requestIdFor(req);
      return reply
        .code(400)
        .send(buildError("validation_error", "validation_failed", "Invalid signup payload. Passwords need at least 12 characters.", requestId));
    }
    try {
      const result = await signup(getPool(), parsed.data);
      return reply.code(201).send({
        user: result.user,
        account: result.account,
        verification: result.verification,
        ...(result.verificationTokenRaw ? { verification_token: result.verificationTokenRaw } : {}),
      });
    } catch (err) {
      sendServiceError(reply, err);
    }
  });

  app.get("/auth/verify", async (req, reply) => {
    const token = (req.query as { token?: unknown }).token;
    if (typeof token !== "string" || token.length < 10) {
      const requestId = requestIdFor(req);
      return reply
        .code(400)
        .send(buildError("validation_error", "validation_failed", "Verification token is required.", requestId));
    }
    try {
      const result = await verifyEmail(getPool(), token);
      return reply.send({ verified: true, user_id: result.user_id });
    } catch (err) {
      sendServiceError(reply, err);
    }
  });

  app.post("/auth/login", async (req, reply) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      const requestId = requestIdFor(req);
      return reply
        .code(400)
        .send(buildError("validation_error", "validation_failed", "Invalid login payload.", requestId));
    }
    try {
      const result = await login(getPool(), parsed.data);
      void reply.setCookie(SESSION_COOKIE, result.sessionToken, {
        httpOnly: true,
        sameSite: "lax",
        secure: env.NODE_ENV === "production",
        path: "/",
        maxAge: 7 * 24 * 60 * 60,
      });
      return reply.send({ user: result.user });
    } catch (err) {
      sendServiceError(reply, err);
    }
  });

  app.post("/auth/logout", async (req, reply) => {
    const token = req.cookies?.[SESSION_COOKIE] as string | undefined;
    if (token) await logout(getPool(), token);
    void reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return reply.send({ logged_out: true });
  });

  app.get("/auth/me", async (req, reply) => {
    const token = req.cookies?.[SESSION_COOKIE] as string | undefined;
    const ctx = await resolveSession(getPool(), token);
    if (!ctx) {
      const requestId = requestIdFor(req);
      return reply
        .code(401)
        .send(buildError("authentication_error", "session_expired", "Session is missing or expired.", requestId));
    }
    return reply.send(ctx);
  });
}
