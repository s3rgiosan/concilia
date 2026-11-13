// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { Channel, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { clearMocks } from "@tauri-apps/api/mocks";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Draft, ReviewData, RunEvent } from "../lib/tauri";
import { install } from "./mock";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

/** The command names `src/lib/tauri.ts` invokes. */
function invokedCommands(): string[] {
  const names = new Set<string>();
  for (const match of read("../lib/tauri.ts").matchAll(/(?:invoke|run)(?:<[^>]*>)?\("([a-z_]+)"/g)) {
    names.add(match[1]);
  }
  return [...names];
}

describe("mock backend", () => {
  it("handles every command the app invokes", () => {
    const mock = read("./mock.ts");
    const commands = invokedCommands();
    expect(commands).toContain("set_menu_state");
    const missing = commands.filter((name) => !mock.includes(`case "${name}"`));
    expect(missing).toEqual([]);
  });
});

/** Installs the mock backend for a scenario of the preview. */
function start(scenario: string) {
  window.history.replaceState(null, "", `/?mock=${scenario}`);
  install();
}

const PERIOD = { year: "2030", month: "03" };

/** Runs a job command, collecting its progress events. Rejects like the command. */
async function job(command: string, args: Record<string, unknown>) {
  const events: RunEvent[] = [];
  const channel = new Channel<RunEvent>();
  channel.onmessage = (event) => events.push(event);
  const promise = invoke(command, { ...PERIOD, ...args, onEvent: channel });
  const settled = promise.then(
    (value) => ({ value, error: null as unknown }),
    (error: unknown) => ({ value: null, error }),
  );
  await vi.advanceTimersByTimeAsync(120_000);
  return { events, ...(await settled) };
}

afterEach(() => {
  clearMocks();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("mock backend behavior", () => {
  it("finalizes with the decisions merged, and reopens with them restored", async () => {
    start("resume");
    const review = await invoke<ReviewData>("get_review", PERIOD);
    const open = review.transactions.find((t) => t.status === "UNMATCHED")!;
    const draft: Draft = { [open.id]: { status: "MATCHED", notes: "transfer" } };
    await invoke("save_draft", { ...PERIOD, draft });
    vi.useFakeTimers();
    const finalizing = invoke("finalize", PERIOD);
    await vi.advanceTimersByTimeAsync(2000);
    await finalizing;
    const finalized = await invoke<ReviewData>("get_review", PERIOD);
    expect(finalized.transactions.find((t) => t.id === open.id)?.status).toBe("MATCHED");
    expect(await invoke("get_draft", PERIOD)).toEqual({});

    const reopening = invoke<{ keptDecisions: number }>("reopen", PERIOD);
    await vi.advanceTimersByTimeAsync(2000);
    expect((await reopening).keptDecisions).toBe(1);
    expect(await invoke("get_draft", PERIOD)).toEqual(draft);
    const reopened = await invoke<ReviewData>("get_review", PERIOD);
    expect(reopened.transactions.find((t) => t.id === open.id)?.status).toBe("UNMATCHED");
  });

  it("shows the added statement in the review and the month summary", async () => {
    start("resume");
    vi.useFakeTimers();
    const before = await invoke<ReviewData>("get_review", PERIOD);
    const added = await job("add_statements", { statements: [{ path: "/Users/example/Downloads/extrato-2030-03-b.pdf", bank: "cgd" }] });
    expect(added.error).toBeNull();
    const after = await invoke<ReviewData>("get_review", PERIOD);
    expect(after.transactions.length).toBe(before.transactions.length + 3);
    expect(after.statements?.length).toBe((before.statements?.length ?? 0) + 1);
    const pending = invoke<{ transactions: number }>("period_summary", PERIOD);
    await vi.advanceTimersByTimeAsync(1000);
    const summary = await pending;
    expect(summary.transactions).toBe(after.transactions.length);
  });

  it("counts the statements that were given", async () => {
    start("resume");
    vi.useFakeTimers();
    const one = await job("add_statements", { statements: [{ path: "/Users/example/Downloads/a.pdf", bank: "cgd" }] });
    expect(one.events[0]).toEqual({ step: "parsing", count: 1 });
    const three = await job("reconcile", { statements: [1, 2, 3].map((n) => ({ path: `/Users/example/Downloads/${n}.pdf`, bank: "cgd" })), clearCache: false });
    expect(three.events[0]).toEqual({ step: "parsing", count: 3 });
  });

  it("fails a run at the step that needs the failing service", async () => {
    start("run-error");
    vi.useFakeTimers();
    const statements = [{ path: "/Users/example/Downloads/a.pdf", bank: "cgd" }];
    const added = await job("add_statements", { statements });
    expect(added.error).toMatchObject({ kind: "parse" });
    expect(added.events.map((e) => e.step)).toEqual(["parsing"]);

    const reconcile = await job("reconcile", { statements, clearCache: false });
    expect(reconcile.error).toMatchObject({ kind: "unauthorized" });
    const steps = reconcile.events.map((e) => e.step);
    expect(steps).toContain("extracting");
    expect(steps).not.toContain("matching");
    expect(steps).not.toContain("exporting");
  });

  it("answers an alert with a third button", async () => {
    start("resume");
    // jsdom has no modal dialogs.
    HTMLDialogElement.prototype.showModal = () => undefined;
    HTMLDialogElement.prototype.close = () => undefined;
    const choice = invoke("show_alert", { request: { title: "Finalize?", message: "Some are open.", confirm: "Finalize", cancel: "Cancel", alternate: "Review Remaining" } });
    const button = Array.from(document.querySelectorAll("button")).find((b) => b.textContent === "Review Remaining");
    expect(button).toBeTruthy();
    button!.click();
    await expect(choice).resolves.toBe("alternate");
    expect(document.querySelector("dialog")).toBeNull();
    delete (HTMLDialogElement.prototype as Partial<HTMLDialogElement>).showModal;
    delete (HTMLDialogElement.prototype as Partial<HTMLDialogElement>).close;
  });

  it("stops sending an event to a listener that was removed", async () => {
    start("configured");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const handler = vi.fn();
    const unlisten = await listen("settings-changed", handler);
    await unlisten();
    await invoke("save_settings", { settings: { language: null, receipts_root: null, gemini: { project: null, location: "europe-west1", model: "gemini-2.5-flash" }, check_for_updates: true } });
    expect(handler).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });
});
