import { createHash } from "node:crypto";
import { ProviderError, type GenerateParams, type MusicProvider, type ProviderCallOptions, type ProviderResult } from "./types.js";

export interface MockProviderOptions {
  /** Fixed simulated generation time. Ignored when latencyRangeMs is set.
   *  Tests pass small values; dev default is 2s. */
  latencyMs: number;
  /** When set, each call sleeps a uniform random time in [min, max] ms instead
   *  of the fixed latencyMs — used in dev/compose to mimic a real render. */
  latencyRangeMs?: [number, number];
  /** Fraction [0,1] of calls that fail. Tests set 0 or 1 deterministically. */
  failRate: number;
  /** Fixed seed for failure sampling; defaults to hashing the request id so
   *  concurrent tests with distinct jobs get independent outcomes. */
  seed?: string;
}

/**
 * Test/stand-in provider. NEVER calls a paid service and NEVER consumes billable
 * allowance (enforced by the service layer: test keys reserve 0). Produces a
 * deterministic 16-bit mono WAV fixture whose tone is derived from the prompt,
 * so identical prompts yield identical bytes (useful for dedupe assertions).
 * Long requests are capped to a short fixture; the job's duration metadata
 * still records the requested length.
 */
const FIXTURE_SEC = 8;
const SAMPLE_RATE = 22050;
/** Below this simulated render time, emitting 25/50/75% ticks is noise (tests
 *  pass millisecond latencies); real dev renders are 40-60s. */
const PROGRESS_MIN_LATENCY_MS = 1000;

export function mockToneFrequencyHz(prompt: string): number {
  const digest = createHash("sha256").update(prompt, "utf8").digest();
  return 220 + (digest.readUInt16BE(0) % 440);
}

function sineWav(prompt: string): Buffer {
  const freq = mockToneFrequencyHz(prompt);
  const n = Math.floor(SAMPLE_RATE * FIXTURE_SEC);
  const data = Buffer.alloc(44 + n * 2);
  data.write("RIFF", 0);
  data.writeUInt32LE(36 + n * 2, 4);
  data.write("WAVE", 8);
  data.write("fmt ", 12);
  data.writeUInt32LE(16, 16);
  data.writeUInt16LE(1, 20); // PCM
  data.writeUInt16LE(1, 22); // mono
  data.writeUInt32LE(SAMPLE_RATE, 24);
  data.writeUInt32LE(SAMPLE_RATE * 2, 28);
  data.writeUInt16LE(2, 32);
  data.writeUInt16LE(16, 34);
  data.write("data", 36);
  data.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const t = i / SAMPLE_RATE;
    const env = Math.min(1, i / (SAMPLE_RATE * 0.05), (n - i) / (SAMPLE_RATE * 0.5));
    const s = Math.sin(2 * Math.PI * freq * t) * 0.6 + Math.sin(2 * Math.PI * freq * 2 * t) * 0.2;
    data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(s * env * 32767))), 44 + i * 2);
  }
  return data;
}

function sampleFailure(failRate: number, seed: string): boolean {
  if (failRate <= 0) return false;
  if (failRate >= 1) return true;
  const digest = createHash("sha256").update(seed, "utf8").digest();
  return digest.readUInt32BE(0) / 0xffffffff < failRate;
}

export class MockMusicProvider implements MusicProvider {
  readonly name = "mock";
  constructor(private readonly opts: MockProviderOptions) {}

  /** Fixed latency, or a fresh uniform sample in [min, max] per call. */
  private pickLatencyMs(): number {
    const range = this.opts.latencyRangeMs;
    if (!range) return this.opts.latencyMs;
    const [min, max] = range;
    if (max <= min) return min;
    return Math.round(min + Math.random() * (max - min));
  }

  async generate(params: GenerateParams, opts: ProviderCallOptions): Promise<ProviderResult> {
    if (opts.signal?.aborted) {
      throw new ProviderError("provider_timeout", "Generation aborted before provider call.");
    }
    const latencyMs = this.pickLatencyMs();
    if (latencyMs > opts.timeoutMs) {
      await sleep(opts.timeoutMs, opts.signal);
      throw new ProviderError("provider_timeout", `Mock provider exceeded timeout of ${opts.timeoutMs}ms.`);
    }
    // Sleep in quarters, reporting progress after each of the first three, so
    // a long render produces a visible 25/50/75% sequence (100% = succeeded).
    // Fast (test-sized) renders skip the callback entirely.
    if (latencyMs >= PROGRESS_MIN_LATENCY_MS) {
      const segments = 4;
      for (let i = 1; i <= segments; i++) {
        await sleep(latencyMs / segments, opts.signal);
        if (i < segments) opts.onProgress?.(Math.round((i * 100) / segments));
      }
    } else {
      await sleep(latencyMs, opts.signal);
    }
    if (opts.signal?.aborted) {
      throw new ProviderError("provider_timeout", "Generation aborted during provider call.");
    }
    if (sampleFailure(this.opts.failRate, this.opts.seed ?? params.providerRequestId)) {
      throw new ProviderError("provider_error", "Mock provider simulated failure.");
    }
    return {
      audio: sineWav(params.prompt),
      format: "wav",
      durationSec: params.durationSec,
      model: "mock/music-1",
    };
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new ProviderError("provider_timeout", "Generation aborted during wait."));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
