import { createHmac, timingSafeEqual } from "node:crypto";
import http from "node:http";

/**
 * Local webhook receiver for the Soundverse dev loop.
 *
 * Defaults match the documented scheme: verify the HMAC-SHA256 signature over
 * "<timestamp>.<raw body>", constant-time compare, reject stale timestamps,
 * dedupe on the stable sv-event-id, always 2xx for anything it accepts.
 *
 *   node scripts/hook-receiver.mjs 9499
 *   WEBHOOK_SECRET=whsec_... node scripts/hook-receiver.mjs 9499
 *   node scripts/hook-receiver.mjs 9499 --events generation.succeeded,generation.failed
 *   node scripts/hook-receiver.mjs 9499 --fail        # force 500s -> retry/dead-letter demo
 *   node scripts/hook-receiver.mjs 9499 --insecure    # skip verification (raw logging)
 */

const EVENT_TYPES = [
  "generation.created",
  "generation.progress",
  "generation.succeeded",
  "generation.failed",
  "generation.canceled",
];

const TOLERANCE_SEC = 300;

function flag(name) {
  return process.argv.includes(`--${name}`);
}

function option(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const port = Number(process.argv[2] ?? 9499);
const secret = option("secret") ?? process.env.WEBHOOK_SECRET ?? "";
const insecure = flag("insecure");
const forceFail = flag("fail");

const eventsArg = option("events") ?? process.env.WEBHOOK_EVENTS ?? "";
const subscribed = new Set(
  eventsArg
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);
for (const e of subscribed) {
  if (!EVENT_TYPES.includes(e)) {
    console.error(`unknown event type "${e}" (known: ${EVENT_TYPES.join(", ")})`);
    process.exit(1);
  }
}

if (!secret && !insecure) {
  console.log("no WEBHOOK_SECRET set and --insecure not passed: deliveries are logged, NOT verified");
}

const seen = new Set();
let accepted = 0;
let duplicates = 0;
let rejected = 0;

/** HMAC-SHA256(secret, "<timestamp>.<raw body>") in `v1=<hex>` form. */
function sign(ts, body) {
  return `v1=${createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex")}`;
}

function verify(ts, body, header) {
  if (!header) return false;
  const expected = Buffer.from(sign(ts, body));
  const actual = Buffer.from(header);
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}

function timestampOk(ts) {
  const delta = Math.abs(Date.now() / 1000 - Number(ts));
  return Number.isFinite(delta) && delta <= TOLERANCE_SEC;
}

function send(res, status, body, extra = {}) {
  res.writeHead(status, { "content-type": "text/plain", ...extra }).end(body);
}

http
  .createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      if (req.method !== "POST") return send(res, 405, "method not allowed");

      const eventId = req.headers["sv-event-id"] ?? "";
      const ts = req.headers["sv-timestamp"] ?? "";
      const signature = req.headers["sv-signature"];

      let parsed = {};
      try {
        parsed = JSON.parse(raw);
      } catch {
        console.log("!! body was not JSON");
      }

      const type = parsed.type ?? "unknown";
      const data = parsed.data ?? {};
      const subscribedOk = subscribed.size === 0 || subscribed.has(type);

      // 1. Signature first: an unsigned/tampered request never reaches handlers.
      let verified = null;
      if (!insecure) {
        if (!secret) verified = null; // unverified mode (logged loudly at boot)
        else if (!verify(ts, raw, signature)) {
          rejected++;
          console.log(`!! REJECTED bad signature (${type}) id=${eventId}`);
          return send(res, 401, "invalid signature");
        } else if (!timestampOk(ts)) {
          rejected++;
          console.log(`!! REJECTED stale timestamp (${type}) id=${eventId}`);
          return send(res, 400, "stale timestamp");
        } else {
          verified = true;
        }
      }

      // 2. Retries re-deliver the same sv-event-id; process each one once.
      const duplicate = eventId !== "" && seen.has(eventId);
      if (duplicate) duplicates++;
      else if (eventId) seen.add(eventId);

      const label = duplicate ? "duplicate" : subscribedOk ? "accepted" : "filtered-out";
      console.log(
        `--- ${label} --- type=${type}` +
          (data.progress !== undefined ? ` progress=${data.progress}%` : "") +
          ` gen=${data.generation_id ?? "-"}` +
          ` verified=${verified} id=${eventId}`,
      );
      if (!subscribedOk) {
        // Not subscribed: ack quietly so the platform stops retrying it.
        return send(res, 200, "ok (filtered)");
      }
      if (duplicate) return send(res, 200, "ok (duplicate)");

      accepted++;
      if (forceFail) {
        console.log("--fail: answering 500 to exercise retries/dead-letter");
        return send(res, 500, "forced failure");
      }
      send(res, 200, "ok");
    });
  })
  .listen(port, () => {
    console.log(`hook receiver listening on :${port}`);
    console.log(
      `  events: ${subscribed.size ? [...subscribed].join(", ") : "all"}` +
        `${secret ? " · signature verification ON" : " · verification OFF"}` +
        `${forceFail ? " · --fail (always 500)" : ""}`,
    );
  });

process.on("SIGINT", () => {
  console.log(`\nsummary: accepted=${accepted} duplicates=${duplicates} rejected=${rejected}`);
  process.exit(0);
});