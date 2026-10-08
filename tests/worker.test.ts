import { describe, expect, it } from "vitest";
import app from "../worker/index";

describe("Worker smoke test", () => {
  it("reports an unconfigured database instead of crashing", async () => {
    const response = await app.request(
      "http://localhost/api/health",
      {},
      {},
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      ok: false,
      environment: "unknown",
      database: "not-configured",
    });
  });
});
