import { describe, expect, it } from "vitest";
import i18n from "../i18n";
import commandsSource from "../../src-tauri/src/commands.rs?raw";
import errorSource from "../../src-tauri/src/error.rs?raw";
import pipelineSource from "../../src-tauri/src/pipeline.rs?raw";
import { ERROR_CODES, ERROR_KINDS, errorDetail, errorKind, friendlyError, isCommandError } from "./errors";

const t = i18n.t;

describe("isCommandError", () => {
  it("accepts every known kind with a message", () => {
    for (const kind of ERROR_KINDS) {
      expect(isCommandError({ kind, message: "x" })).toBe(true);
    }
  });

  it("accepts a code", () => {
    expect(isCommandError({ kind: "io", message: "x", code: "not_pdf" })).toBe(true);
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
    expect(isCommandError({ kind: "io", message: "x", code: 1 })).toBe(false);
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
    invalid_input: "Concilia can't use that value. Check it and try again.",
    not_found: "Concilia can't find that item. It may have been moved or deleted.",
    busy: "Another action is already running for this month. Wait for it to finish, then try again.",
    not_configured: "Finish setting up Concilia in Settings, then try again.",
    keychain: "Concilia can't use the Keychain. Check that it is unlocked, then try again.",
    unauthorized: "Google didn't accept the key. Check the key, the project and that the Agent Platform API is enabled.",
    network: "Concilia can't reach Google. Check your internet connection and try again.",
    poppler_missing: "The PDF tools Concilia needs are missing. Reinstall Concilia.",
    parse: "Concilia couldn't read the statement. Check that it comes from the bank selected for it.",
    finalized: "This month is finalized. Reconcile it again to scan for receipts.",
    cancelled: "Reconciliation stopped.",
    timeout: "Reconciliation took longer than 30 minutes and was stopped. Try again.",
    read_only: "The settings were saved by a newer version of Concilia and are read-only.",
    io: "Concilia couldn't read or write a file. Check that the folder is available, then try again.",
    internal: "Concilia ran into a problem. Try again, and if it keeps happening, restart the app.",
  };

  it.each(ERROR_KINDS.map((kind) => [kind]))("describes a %s error without its message", (kind) => {
    expect(friendlyError({ kind, message: "bad value" }, t)).toBe(expected[kind]);
  });

  it("words a known code ahead of its kind", () => {
    expect(friendlyError({ kind: "invalid_input", message: "x.txt is not a PDF file", code: "not_pdf" }, t)).toBe(
      "Only PDF statements can be added.",
    );
    expect(friendlyError({ kind: "not_found", message: "x", code: "not_reconciled" }, t)).toBe(
      "This month hasn't been reconciled yet. Reconcile it first.",
    );
  });

  it("has a sentence in both languages for every code", async () => {
    await i18n.changeLanguage("pt");
    try {
      for (const code of ERROR_CODES) {
        const sentence = friendlyError({ kind: "io", message: "x", code }, i18n.t);
        expect(sentence, code).not.toContain("errors.codes");
        expect(sentence, code).not.toBe(friendlyError({ kind: "io", message: "x" }, i18n.t));
      }
    } finally {
      await i18n.changeLanguage("en");
    }
  });

  it("lists every code the backend sets", () => {
    const sources = [commandsSource, errorSource, pipelineSource];
    const sent = new Set<string>();
    for (const source of sources) {
      for (const match of source.matchAll(/coded\(\s*ErrorKind::\w+,\s*"([a-z_]+)"/g)) {
        sent.add(match[1]);
      }
    }
    expect(sent.size).toBeGreaterThan(0);
    for (const code of sent) {
      expect(ERROR_CODES as readonly string[], code).toContain(code);
      expect(i18n.exists(`errors.codes.${code}`), code).toBe(true);
    }
  });

  it("falls back to the kind for an unknown code", () => {
    expect(friendlyError({ kind: "io", message: "x", code: "unheard_of" }, t)).toBe(expected.io);
  });

  it("describes any other failure in general terms", () => {
    expect(friendlyError(new Error("disk full"), t)).toBe(expected.internal);
    expect(friendlyError("socket closed", t)).toBe(expected.internal);
    expect(friendlyError(undefined, t)).toBe(expected.internal);
    expect(friendlyError({ reason: "x" }, t)).toBe(expected.internal);
  });
});

describe("errorDetail", () => {
  it("returns the backend message of a command error", () => {
    expect(errorDetail({ kind: "io", message: "/Users/example/<a & b>.pdf" })).toBe("/Users/example/<a & b>.pdf");
  });

  it("returns nothing when the sentence says it all", () => {
    expect(errorDetail({ kind: "cancelled", message: "cancelled" })).toBeNull();
    expect(errorDetail({ kind: "timeout", message: "the run took longer than 30 minutes" })).toBeNull();
    expect(errorDetail({ kind: "invalid_input", message: "x", code: "no_transactions" })).toBeNull();
    expect(errorDetail({ kind: "io", message: "  " })).toBeNull();
  });

  it("returns the message of an Error or a string", () => {
    expect(errorDetail(new Error("disk full"))).toBe("disk full");
    expect(errorDetail("socket closed")).toBe("socket closed");
  });

  it("returns nothing for values with no message", () => {
    expect(errorDetail(undefined)).toBeNull();
    expect(errorDetail(null)).toBeNull();
    expect(errorDetail({ reason: "x" })).toBeNull();
    expect(errorDetail(new Error(""))).toBeNull();
  });
});
