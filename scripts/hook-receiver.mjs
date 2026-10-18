import http from "node:http";

/**
 * Tiny local webhook receiver for the quickstart flow only.
 * Logs each delivery (headers + body) and always answers 200.
 * It does NOT verify signatures — verify them in your own integration with
 * the documented scheme (HMAC-SHA256 over "<timestamp>.<raw body>",
 * constant-time compare, 300s timestamp tolerance, dedupe on sv-event-id).
 */
const port = Number(process.argv[2] ?? 9499);
http
  .createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      console.log("--- delivery ---");
      console.log("event:", req.headers["sv-event-id"]);
      console.log("timestamp:", req.headers["sv-timestamp"]);
      console.log("signature:", req.headers["sv-signature"]);
      console.log("body:", body);
      res.writeHead(200, { "content-type": "text/plain" }).end("ok");
    });
  })
  .listen(port, () => console.log(`hook receiver listening on :${port}`));
