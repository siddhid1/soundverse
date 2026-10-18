import { z } from "zod";

export const LICENSES = ["royalty_free", "sync", "full_ownership"] as const;
export type License = (typeof LICENSES)[number];

/** Base credits per started 60-second segment. */
export const LICENSE_BASE_COST: Record<License, number> = {
  royalty_free: 1,
  sync: 6,
  full_ownership: 14,
};

/** credits = license_cost * ceil(duration_sec / 60). */
export function creditsFor(license: License, durationSec: number): number {
  return LICENSE_BASE_COST[license] * Math.ceil(durationSec / 60);
}

/**
 * Billing period anchor: first day of the current UTC calendar month.
 * Allowance resets automatically (queries filter on period_start); nothing
 * rolls over because balances are always computed per period.
 */
export function currentPeriodStart(now: Date = new Date()): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}-01`;
}

/** Validated generation payload. Canonicalized (defaults applied) BEFORE hashing. */
export const generationInputSchema = z.object({
  prompt: z.string().min(1).max(2000),
  duration_sec: z.number().int().min(5).max(300),
  license: z.enum(LICENSES),
  instrumental: z.boolean().optional().default(true),
  metadata: z
    .record(z.string(), z.unknown())
    .refine((o) => Object.keys(o).length <= 50, "metadata has too many keys (max 50)")
    .optional(),
});

export type GenerationInput = z.infer<typeof generationInputSchema>;

export const generationStatusFilter = z.enum(["queued", "running", "succeeded", "failed", "canceled"]);
export type GenerationStatus = z.infer<typeof generationStatusFilter>;
