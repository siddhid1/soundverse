import { describe, expect, it } from "vitest";
import { buildError, statusForCode } from "../src/lib/errors.js";

describe("canonical error shape", () => {
  it("maps parallel-limit code to 429", () => {
    expect(statusForCode("parallel_limit_reached")).toBe(429);
    const body = buildError("rate_limit_error", "parallel_limit_reached", "Slow down.", "req_x");
    expect(body).toEqual({
      error: { type: "rate_limit_error", code: "parallel_limit_reached", message: "Slow down.", request_id: "req_x" },
    });
  });
});
