import { describe, expect, it } from "vitest";
import { locationHash, parseLocation } from "../frontend/lib/routes";

describe("application routes", () => {
  it("parses public user profile ids without exposing the route in navigation", () => {
    const location = parseLocation("#/users/42");

    expect(location.route.id).toBe("users");
    expect(location.route.hidden).toBe(true);
    expect(location.subpath).toBe("42");
    expect(locationHash(location)).toBe("#/users/42");
  });

  it("rejects non-numeric public profile ids", () => {
    expect(parseLocation("#/users/maya_r").route.id).toBe("profile");
    expect(parseLocation("#/users/0").route.id).toBe("profile");
  });
});
