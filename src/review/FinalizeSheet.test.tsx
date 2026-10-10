// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FinalizeCounts } from "./effective";
import { FinalizeSheet } from "./FinalizeSheet";

afterEach(() => {
  cleanup();
});

const COUNTS: FinalizeCounts = { matched: 31, review: 2, unmatched: 5, total: 38 };

function renderSheet({ counts = COUNTS, pending = 0, busy = false } = {}) {
  const onCancel = vi.fn();
  const onConfirm = vi.fn();
  render(<FinalizeSheet period="March 2030" counts={counts} pending={pending} busy={busy} onCancel={onCancel} onConfirm={onConfirm} />);
  return { onCancel, onConfirm };
}

const finalizeButton = () => screen.getByRole("button", { name: "Finalize" }) as HTMLButtonElement;

describe("FinalizeSheet", () => {
  it("is a destructive alert naming the month and where the receipts go", () => {
    renderSheet();
    const sheet = screen.getByRole("alertdialog", { name: "Finalize March 2030?" });
    const description = document.getElementById(sheet.getAttribute("aria-describedby")!);
    expect(description?.textContent).toBe(
      "38 receipts will be moved: 31 to _matched, 2 to _review, 5 to _unmatched. Your draft will be deleted. You can't undo this.",
    );
    expect(finalizeButton().classList.contains("destructive")).toBe(true);
    expect(finalizeButton().disabled).toBe(false);
    expect(screen.queryByRole("checkbox")).toBeNull();
  });

  it("makes Cancel the default button", () => {
    renderSheet();
    const cancel = screen.getByRole("button", { name: "Cancel" });
    expect(cancel.classList.contains("default")).toBe(true);
    expect(document.activeElement).toBe(cancel);
  });

  it("counts one receipt and none", () => {
    renderSheet({ counts: { matched: 1, review: 0, unmatched: 0, total: 1 } });
    expect(screen.getByText(/^1 receipt will be moved: 1 to _matched, 0 to _review, 0 to _unmatched\./)).toBeTruthy();
    cleanup();
    renderSheet({ counts: { matched: 0, review: 0, unmatched: 0, total: 0 } });
    expect(screen.getByText(/^No receipts will be moved\. Your draft will be deleted\./)).toBeTruthy();
  });

  it("warns about transactions still needing a decision", () => {
    renderSheet({ pending: 6 });
    expect(screen.getByText("6 transactions still need a decision.")).toBeTruthy();
    cleanup();
    renderSheet({ pending: 1 });
    expect(screen.getByText("1 transaction still needs a decision.")).toBeTruthy();
    cleanup();
    renderSheet();
    expect(screen.queryByText(/still need/)).toBeNull();
  });

  it("confirms and cancels", () => {
    const { onCancel, onConfirm } = renderSheet();
    fireEvent.click(finalizeButton());
    expect(onConfirm).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("shows the work in progress and blocks both buttons while busy", () => {
    const { onConfirm } = renderSheet({ busy: true });
    const working = screen.getByRole("button", { name: "Working…" }) as HTMLButtonElement;
    expect(working.disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(working);
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
