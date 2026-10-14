import { describe, expect, it } from "vitest";
import app from "../worker/index";

describe("Worker health check", () => {
  it("reports an unconfigured database instead of crashing", async () => {
    const response = await app.request(
      "http://localhost/api/health",
      {},
      {},
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      ok: false,
      database: "not-configured",
    });
  });
});
