import { describe, expect, it } from "vitest";
import { locationHash, parseLocation, routes } from "../frontend/lib/routes";

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

  it("exposes Maps to regular users and admins", () => {
    const maps = routes.find((route) => route.id === "maps");

    expect(maps?.label).toBe("Maps");
    expect(maps?.adminOnly).toBeUndefined();
    expect(parseLocation("#/maps").route.id).toBe("maps");
  });

  it("exposes admin sections as admin-only CampusConnect routes", () => {
    expect(routes.filter((route) => route.adminOnly).map((route) => route.label)).toEqual([
      "Overview",
      "Users",
      "Reservations",
      "Resources",
      "Buildings",
    ]);

    const location = parseLocation("#/admin-users/42");
    expect(location.route.id).toBe("admin-users");
    expect(location.subpath).toBe("42");
    expect(locationHash(location)).toBe("#/admin-users/42");
  });
});
