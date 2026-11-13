import { describe, expect, it } from "vitest";
import {
  ADMIN_COMMAND_USAGE,
  parseAdminCommandArgs,
} from "../db/scripts/admin-command";
import {
  VERIFY_USER_EMAIL_USAGE,
  parseVerifyUserEmailArgs,
} from "../db/scripts/verify-user-email";

describe("admin command arguments", () => {
  it("parses a ban action", () => {
    expect(
      parseAdminCommandArgs([
        "--user",
        "maya_r",
        "--ban",
        "true",
        "--env",
        "dev",
      ]),
    ).toEqual({
      environment: "dev",
      username: "maya_r",
      action: { kind: "ban", value: true },
    });
  });

  it("parses role, resource, and delete actions", () => {
    expect(parseAdminCommandArgs(["--user", "maya_r", "--role", "admin", "--env", "prod"]).action)
      .toEqual({ kind: "role", value: "admin" });
    expect(parseAdminCommandArgs(["--user", "maya_r", "--can_add_resources", "false", "--env", "dev"]).action)
      .toEqual({ kind: "can_add_resources", value: false });
    expect(parseAdminCommandArgs(["--user", "maya_r", "--delete", "--env", "dev"]).action)
      .toEqual({ kind: "delete" });
  });

  it("rejects missing, invalid, or conflicting arguments", () => {
    expect(() => parseAdminCommandArgs(["--user", "maya_r", "--env", "dev"]))
      .toThrow("Choose one action");
    expect(() => parseAdminCommandArgs(["--user", "maya_r", "--ban", "maybe", "--env", "dev"]))
      .toThrow("--ban must be true or false");
    expect(() => parseAdminCommandArgs(["--user", "maya_r", "--delete", "--role", "admin", "--env", "dev"]))
      .toThrow("Choose exactly one action");
    expect(() => parseAdminCommandArgs(["--user", "maya_r", "--env", "staging", "--delete"]))
      .toThrow("--env must be dev or prod");
  });

  it("provides help text", () => {
    expect(() => parseAdminCommandArgs(["--help"])).toThrow(ADMIN_COMMAND_USAGE);
  });
});

describe("verify user email arguments", () => {
  it("requires one username and one environment", () => {
    expect(parseVerifyUserEmailArgs(["--user", "maya_r", "--env", "dev"])).toEqual({
      environment: "dev",
      username: "maya_r",
    });
  });

  it("rejects missing, invalid, or conflicting arguments", () => {
    expect(() => parseVerifyUserEmailArgs(["--user", "maya_r"])).toThrow("--env is required");
    expect(() => parseVerifyUserEmailArgs(["--user", "maya_r", "--env", "staging"]))
      .toThrow("--env must be dev or prod");
    expect(() => parseVerifyUserEmailArgs(["--user", "maya_r", "--user", "other", "--env", "dev"]))
      .toThrow("--user may only be provided once");
  });

  it("provides help text", () => {
    expect(() => parseVerifyUserEmailArgs(["--help"])).toThrow(VERIFY_USER_EMAIL_USAGE);
  });
});
