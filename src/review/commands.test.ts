import { describe, expect, it, vi } from "vitest";
import { menuCommand, menuState, REVIEW_COMMANDS, runMenuCommand, type ReviewAvailability, type ReviewCommands } from "./commands";

function availability(value: boolean): ReviewAvailability {
  return Object.fromEntries(REVIEW_COMMANDS.map((c) => [c, value])) as ReviewAvailability;
}

function commands(can: ReviewAvailability = availability(true)): ReviewCommands {
  const fns = Object.fromEntries(REVIEW_COMMANDS.map((c) => [c, vi.fn()]));
  return { ...(fns as unknown as Omit<ReviewCommands, "can">), can };
}

describe("menuCommand", () => {
  it("maps menu items to review commands", () => {
    expect(menuCommand("accept")).toBe("accept");
    expect(menuCommand("quick_look")).toBe("quickLook");
    expect(menuCommand("open_in_preview")).toBe("openInPreview");
    expect(menuCommand("next_pending")).toBe("nextPending");
    expect(menuCommand("previous_pending")).toBe("previousPending");
    expect(menuCommand("find")).toBe("focusSearch");
    expect(menuCommand("toggle_inspector")).toBe("toggleInspector");
    expect(menuCommand("export_report")).toBe("exportReport");
    expect(menuCommand("filter_unmatched")).toBe("setFilter");
    expect(menuCommand("no_receipt_bank_fee")).toBe("noReceipt");
    expect(menuCommand("no_receipt")).toBe("noReceipt");
  });

  it("leaves other items to the window", () => {
    expect(menuCommand("reconcile")).toBeNull();
    expect(menuCommand("toggle_sidebar")).toBeNull();
    expect(menuCommand("open_report")).toBeNull();
  });
});

describe("runMenuCommand", () => {
  it("runs the command with its argument", () => {
    const c = commands();
    expect(runMenuCommand(c, "filter_review")).toBe(true);
    expect(c.setFilter).toHaveBeenCalledWith("review");
    runMenuCommand(c, "no_receipt_no_receipt");
    expect(c.noReceipt).toHaveBeenCalledWith("no_receipt");
    runMenuCommand(c, "undo");
    expect(c.undo).toHaveBeenCalledTimes(1);
    runMenuCommand(c, "find");
    expect(c.focusSearch).toHaveBeenCalledTimes(1);
  });

  it("skips an unavailable command but still claims the item", () => {
    const c = commands(availability(false));
    expect(runMenuCommand(c, "accept")).toBe(true);
    expect(c.accept).not.toHaveBeenCalled();
  });

  it("ignores the submenu itself and items it does not handle", () => {
    const c = commands();
    expect(runMenuCommand(c, "no_receipt")).toBe(true);
    expect(c.noReceipt).not.toHaveBeenCalled();
    expect(runMenuCommand(c, "reconcile")).toBe(false);
  });
});

describe("menuState", () => {
  it("enables each item from its command", () => {
    const can = { ...availability(false), accept: true, setFilter: true, noReceipt: true };
    const state = menuState(can);
    expect(state.accept).toBe(true);
    expect(state.reject).toBe(false);
    expect(state.filter_all).toBe(true);
    expect(state.filter_matched).toBe(true);
    expect(state.no_receipt).toBe(true);
    expect(state.no_receipt_salary).toBe(true);
    expect(state.undo).toBe(false);
    expect(Object.keys(state)).toHaveLength(24);
  });
});
