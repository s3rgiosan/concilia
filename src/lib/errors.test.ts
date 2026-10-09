import { describe, expect, it } from "vitest";
import i18n from "../i18n";
import { ERROR_KINDS, errorKind, friendlyError, isCommandError } from "./errors";

const t = i18n.t;

describe("isCommandError", () => {
  it("accepts every known kind with a message", () => {
    for (const kind of ERROR_KINDS) {
      expect(isCommandError({ kind, message: "x" })).toBe(true);
    }
  });

  it("rejects other values", () => {
    expect(isCommandError(null)).toBe(false);
    expect(isCommandError(undefined)).toBe(false);
    expect(isCommandError("network")).toBe(false);
    expect(isCommandError(42)).toBe(false);
    expect(isCommandError({ kind: "network" })).toBe(false);
    expect(isCommandError({ kind: "network", message: 1 })).toBe(false);
    expect(isCommandError({ kind: "unheard_of", message: "x" })).toBe(false);
    expect(isCommandError({ kind: 1, message: "x" })).toBe(false);
    expect(isCommandError(new Error("network"))).toBe(false);
  });
});

describe("errorKind", () => {
  it("returns the kind of a command error", () => {
    expect(errorKind({ kind: "busy", message: "" })).toBe("busy");
  });

  it("returns null for anything else", () => {
    expect(errorKind(new Error("x"))).toBeNull();
    expect(errorKind({ kind: "nope", message: "" })).toBeNull();
    expect(errorKind(null)).toBeNull();
  });
});

describe("friendlyError", () => {
  const expected: Record<(typeof ERROR_KINDS)[number], string> = {
    invalid_input: "bad value",
    not_found: "bad value",
    busy: "Another job is running for this month. Wait for it to finish and try again.",
    not_configured: "Finish the setup in Settings first: bad value.",
    keychain: "Concilia can't use the Keychain: bad value",
    unauthorized: "Google refused the service account. Check the key and the project, and that the Agent Platform API is enabled.",
    network: "Concilia can't reach the server. Check your internet connection.",
    poppler_missing: "The PDF tools Concilia needs are missing. Reinstall Concilia.",
    parse: "Concilia couldn't read the statement: bad value",
    finalized: "This month is finalized. Re-run it to scan for receipts again.",
    cancelled: "Stopped.",
    timeout: "The run took longer than 30 minutes and was stopped.",
    read_only: "The settings were saved by a newer version of Concilia and are read-only.",
    io: "Concilia couldn't read or write a file: bad value",
    internal: "Something went wrong: bad value",
  };

  it.each(ERROR_KINDS.map((kind) => [kind]))("describes a %s error", (kind) => {
    expect(friendlyError({ kind, message: "bad value" }, t)).toBe(expected[kind]);
  });

  it("does not escape the message", () => {
    expect(friendlyError({ kind: "io", message: "/Users/example/<a & b>.pdf" }, t)).toBe(
      "Concilia couldn't read or write a file: /Users/example/<a & b>.pdf",
    );
  });

  it("describes an Error by its message", () => {
    expect(friendlyError(new Error("disk full"), t)).toBe("Something went wrong: disk full");
  });

  it("describes a string error", () => {
    expect(friendlyError("socket closed", t)).toBe("Something went wrong: socket closed");
  });

  it("falls back for values with no message", () => {
    expect(friendlyError(undefined, t)).toBe("Something went wrong.");
    expect(friendlyError(null, t)).toBe("Something went wrong.");
    expect(friendlyError({ reason: "x" }, t)).toBe("Something went wrong.");
    expect(friendlyError("", t)).toBe("Something went wrong.");
    expect(friendlyError(new Error(""), t)).toBe("Something went wrong.");
  });
});
