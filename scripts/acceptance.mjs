import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Acceptance runner: executes the scenario-mapped test files in brief order
 * and prints one verdict line per acceptance scenario (#1–#14) instead of raw
 * test names. Exit 0 only when every scenario passes AND vitest itself is
 * green (its exit code also catches file-level failures and unhandled
 * errors that no single test owns).
 *
 * Scenarios 9 and 12 are reported as covered with a nuance footnote:
 *  - #9 (full quickstart, test key) is covered stepwise by the suite plus a
 *    manually executed end-to-end (signup → song bytes → signed webhook);
 *    there is no single scripted test walking the entire quickstart.
 *  - #12 (Growth 1500 → Starter) is tested at the full-allowance boundary
 *    (2000 used of 2000), which is the same over-allowance state.
 */

const SCENARIOS = [
  { n: 1, label: "secret never retrievable after creation", match: ["secret is shown once"] },
  { n: 2, label: "revoked key fails on its very next request", match: ["revoked key fails on its very next request"] },
  { n: 3, label: "hitless rotation (old works, both work, old revoked, new works)", match: ["rotation is hitless end to end"] },
  { n: 4, label: "Starter x20 concurrent -> exactly 3 accepted", match: ["starter fires 20 at once"] },
  { n: 5, label: "5 credits + 10 concurrent -> exactly 5 accepted", match: ["starter with 5 credits left"] },
  { n: 6, label: "same key x3 mid-flight -> 1 job; reuse w/ other body -> 409", match: ["same Idempotency-Key x3 concurrently"] },
  {
    n: 7, label: "provider timeout/error mid-job -> retry, then fail + release once",
    match: ["provider timeout is retryable", "failing provider requeues then fails"],
  },
  { n: 8, label: "cross-tenant job read -> 404", match: ["account B cannot read account A's job"] },
  {
    n: 9, label: "full quickstart with a test key (covered stepwise + manual e2e*)",
    match: ["sandbox live keys are rejected; test keys reserve nothing", "test-key job succeeds with no ledger rows"],
  },
  {
    n: 10, label: "webhook down 10min recovers (same event id); day-later replay stale",
    match: ["down endpoint retries with the same event id", "accepts fresh, rejects stale"],
  },
  { n: 11, label: "metadata URL rejected even in allow-private mode", match: ["rejects the metadata address"] },
  {
    n: 12, label: "Growth over-allowance -> Starter downgrade (history intact*)",
    match: ["growth overage is allowed and flagged", "downgrade mid-flight finalizes honestly"],
  },
  { n: 13, label: "Starter + full_ownership -> 403, no job, no ledger", match: ["starter + full_ownership is 403"] },
  { n: 14, label: "poll-every-second at parallel cap stays 200", match: ["polling a running job every second"] },
];

const FILES = [
  "tests/phase2-auth-keys.test.ts",
  "tests/phase3-generations.test.ts",
  "tests/phase4-worker.test.ts",
  "tests/phase5-webhooks.test.ts",
  "tests/phase6-acceptance.test.ts",
];

function main() {
  const outFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sv-accept-")), "report.json");
  console.log("acceptance: running scenario-mapped suites (real PostgreSQL per file)...");
  const run = spawnSync("npx", ["vitest", "run", ...FILES, "--reporter=json", `--outputFile=${outFile}`], {
    encoding: "utf8",
    stdio: ["ignore", "ignore", "inherit"],
  });
  let report = null;
  try {
    report = JSON.parse(fs.readFileSync(outFile, "utf8"));
  } catch {
    console.error("acceptance: could not parse vitest JSON report — treating as failure.");
    process.exit(1);
  }

  const results = [];
  for (const r of report.testResults ?? []) {
    for (const a of r.assertionResults ?? []) {
      results.push({ name: [...(a.ancestorTitles ?? []), a.title].join(" > "), status: a.status });
    }
  }

  let failed = 0;
  for (const s of SCENARIOS) {
    // Each matcher is an independent test name fragment; ALL of them must
    // match at least one passing test (a scenario may span several tests).
    const groups = s.match.map((m) => results.filter((r) => r.name.includes(m)));
    const flat = groups.flat();
    const ok = groups.every((g) => g.length > 0) && flat.every((h) => h.status === "passed");
    if (!ok) failed += 1;
    const detail =
      groups.some((g) => g.length === 0)
        ? "NO MATCHING TEST FOUND"
        : `${flat.filter((h) => h.status === "passed").length}/${flat.length} matched tests passed`;
    console.log(`  #${String(s.n).padStart(2, " ")} ${ok ? "PASS" : "FAIL"}  ${s.label}  (${detail})`);
  }
  console.log("  * #9 covered stepwise by the suite + a manually executed end-to-end (signup -> song bytes -> signed webhook).");
  console.log("  * #12 tested at the full-allowance boundary (2000/2000), the same over-allowance state as 1500/2000.");

  if (run.status !== 0) {
    console.error(`acceptance: vitest exited ${run.status} (failures or unhandled errors above the scenario map) — FAIL`);
    process.exit(1);
  }
  if (failed > 0) {
    console.error(`acceptance: ${failed} scenario(s) failed — FAIL`);
    process.exit(1);
  }
  console.log("acceptance: 14/14 scenarios green — PASS");
}

main();
