import { ProviderError, type GenerateParams, type MusicProvider, type ProviderResult } from "./types.js";

export interface ElevenLabsOptions {
  apiKey: string;
  /** Overridable for tests/stubs. Defaults to the public ElevenLabs API. */
  baseUrl: string;
  modelId: string;
}

/**
 * Real-model adapter (ElevenLabs Music). Selected ONLY when PROVIDER=elevenlabs
 * AND the request uses a live key — test keys always route to the mock and can
 * never reach this code path (enforced in the worker, not by request data).
 *
 * Integration notes (verify against current vendor docs before enabling):
 * - Auth is a server-side secret (xi-api-key); it never leaves the worker.
 * - Endpoint path/shape below follows the vendor's music-generation API;
 *   baseUrl/model are env-configurable so doc drift needs no deploy.
 * - No failover in this sprint: timeouts/errors fail the job with bounded
 *   retries (see worker), they never silently switch models — the license a
 *   customer bought must match the model that actually rendered.
 * - Total real-model spend for this assignment stays under USD 10; automated
 *   tests use the mock or a local stub server, never this adapter live.
 */
export class ElevenLabsMusicProvider implements MusicProvider {
  readonly name = "elevenlabs";
  constructor(private readonly opts: ElevenLabsOptions) {}

  async generate(
    params: GenerateParams,
    opts: { timeoutMs: number; signal?: AbortSignal },
  ): Promise<ProviderResult> {
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(new Error("provider timeout")), opts.timeoutMs);
    try {
      const res = await fetch(`${this.opts.baseUrl.replace(/\/$/, "")}/v1/music`, {
        method: "POST",
        headers: {
          "xi-api-key": this.opts.apiKey,
          "Content-Type": "application/json",
          Accept: "audio/mpeg",
        },
        body: JSON.stringify({
          prompt: params.prompt,
          music_length_ms: Math.round(params.durationSec * 1000),
          model_id: this.opts.modelId,
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const body = (await res.text().catch(() => "")).slice(0, 500);
        const retryable = res.status === 429 || res.status >= 500;
        throw new ProviderError(
          "provider_error",
          `ElevenLabs music request failed with HTTP ${res.status}: ${body}`,
          retryable,
        );
      }
      const audio = Buffer.from(await res.arrayBuffer());
      if (audio.length === 0) throw new ProviderError("provider_error", "ElevenLabs returned empty audio.");
      return {
        audio,
        format: "mp3",
        durationSec: params.durationSec,
        model: this.opts.modelId,
        providerJobId: res.headers.get("request-id") ?? undefined,
      };
    } catch (err) {
      if (err instanceof ProviderError) throw err;
      if (err instanceof Error && /abort/i.test(`${err.message} ${err.cause ?? ""}${err.name}`)) {
        throw new ProviderError("provider_timeout", `ElevenLabs music request timed out after ${opts.timeoutMs}ms.`);
      }
      throw new ProviderError("provider_error", `ElevenLabs music request failed: ${(err as Error).message}`);
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
    }
  }
}
