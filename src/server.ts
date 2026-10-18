import { buildApp } from "./app.js";
import { getEnv } from "./config/env.js";

async function main(): Promise<void> {
  const env = getEnv();
  const app = await buildApp();
  try {
    await app.listen({ host: env.HOST, port: env.PORT });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

void main();
