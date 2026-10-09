// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FinalizeSheet } from "./FinalizeSheet";

afterEach(() => {
  cleanup();
});

function renderSheet(busy = false) {
  const onCancel = vi.fn();
  const onConfirm = vi.fn();
  render(<FinalizeSheet busy={busy} onCancel={onCancel} onConfirm={onConfirm} />);
  return { onCancel, onConfirm };
}

const finalizeButton = () => screen.getByRole("button", { name: "Finalize" }) as HTMLButtonElement;

describe("FinalizeSheet", () => {
  it("is a destructive alert describing the irreversible move", () => {
    renderSheet();
    const sheet = screen.getByRole("alertdialog", { name: "Finalize reconciliation?" });
    expect(sheet.getAttribute("aria-describedby")).toBeTruthy();
    expect(screen.getByText(/The action cannot be undone\./)).toBeTruthy();
    expect(finalizeButton().classList.contains("destructive")).toBe(true);
  });

  it("disables Finalize until the checkbox is ticked", () => {
    const { onConfirm } = renderSheet();
    expect(finalizeButton().disabled).toBe(true);
    fireEvent.click(finalizeButton());
    expect(onConfirm).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("checkbox", { name: "I understand this action is irreversible" }));
    expect(finalizeButton().disabled).toBe(false);
    fireEvent.click(finalizeButton());
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("disables Finalize again when the checkbox is cleared", () => {
    renderSheet();
    const checkbox = screen.getByRole("checkbox");
    fireEvent.click(checkbox);
    fireEvent.click(checkbox);
    expect(finalizeButton().disabled).toBe(true);
  });

  it("cancels", () => {
    const { onCancel } = renderSheet();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("shows the work in progress and blocks both buttons while busy", () => {
    renderSheet(true);
    fireEvent.click(screen.getByRole("checkbox"));
    const working = screen.getByRole("button", { name: "Working…" }) as HTMLButtonElement;
    expect(working.disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
