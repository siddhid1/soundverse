/**
 * Provider abstraction. Exactly one method to implement per vendor; the worker
 * owns timeouts, retries, lease renewal, upload and ledger finalization, so
 * adapters stay thin and swappable (failover later = list of these).
 */
export interface GenerateParams {
  prompt: string;
  durationSec: number;
  instrumental: boolean;
  /** Provider-side idempotency / deduplication key (our generation id). */
  providerRequestId: string;
}

export interface ProviderResult {
  /** Raw audio bytes (never a URL — the worker uploads to our storage). */
  audio: Buffer;
  /** Container/format of `audio`, e.g. "wav" (mock) or "mp3" (vendors). */
  format: string;
  /** Actual duration of the returned audio in seconds. */
  durationSec: number;
  /** Model identifier to record on the job, e.g. "mock/music-1". */
  model: string;
  /** Vendor-side job/run id when the API is asynchronous. */
  providerJobId?: string;
}

export class ProviderError extends Error {
  code: "provider_error" | "provider_timeout";
  retryable: boolean;
  constructor(code: "provider_error" | "provider_timeout", message: string, retryable = true) {
    super(message);
    this.code = code;
    this.retryable = retryable;
  }
}

export interface MusicProvider {
  readonly name: string;
  generate(params: GenerateParams, opts: { timeoutMs: number; signal?: AbortSignal }): Promise<ProviderResult>;
}
