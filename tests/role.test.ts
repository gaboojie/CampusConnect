import { describe, expect, it } from "vitest";
import { parseRoleCommandArgs } from "../db/scripts/role";

describe("role command arguments", () => {
  it("accepts a username target", () => {
    expect(
      parseRoleCommandArgs([
        "--username",
        "maya_r",
        "--role",
        "admin",
        "--env",
        "dev",
      ]),
    ).toEqual({
      environment: "dev",
      identifierType: "username",
      identifier: "maya_r",
      role: "admin",
    });
  });

  it("accepts an email target and user role", () => {
    expect(
      parseRoleCommandArgs([
        "--email",
        "maya.r@example.com",
        "--role",
        "user",
        "--env",
        "prod",
      ]),
    ).toEqual({
      environment: "prod",
      identifierType: "email",
      identifier: "maya.r@example.com",
      role: "user",
    });
  });

  it("requires exactly one username or email", () => {
    expect(() =>
      parseRoleCommandArgs(["--role", "admin", "--env", "dev"]),
    ).toThrow("Provide exactly one of --username or --email");

    expect(() =>
      parseRoleCommandArgs([
        "--username",
        "maya_r",
        "--email",
        "maya.r@example.com",
        "--role",
        "admin",
        "--env",
        "dev",
      ]),
    ).toThrow("Provide exactly one of --username or --email");
  });
});
