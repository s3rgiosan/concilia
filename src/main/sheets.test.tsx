// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NewMonthSheet } from "./NewMonthSheet";
import { RerunSheet } from "./RerunSheet";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2030, 3, 15));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("NewMonthSheet", () => {
  function renderSheet() {
    const onCancel = vi.fn();
    const onCreate = vi.fn();
    render(<NewMonthSheet initial={{ year: "2030", month: "03" }} onCancel={onCancel} onCreate={onCreate} />);
    return { onCancel, onCreate };
  }

  it("starts on the given month", () => {
    renderSheet();
    const sheet = screen.getByRole("dialog", { name: "New Month" });
    expect((within(sheet).getByLabelText("Month") as HTMLSelectElement).value).toBe("03");
    expect((within(sheet).getByLabelText("Year") as HTMLSelectElement).value).toBe("2030");
    expect(document.activeElement).toBe(within(sheet).getByLabelText("Month"));
  });

  it("writes its labels without punctuation", () => {
    renderSheet();
    const labels = Array.from(document.querySelectorAll(".sheet__grid > label")).map((label) => label.textContent);
    expect(labels).toEqual(["Month", "Year"]);
  });

  it("offers every year from next year down to 2000", () => {
    renderSheet();
    const years = within(screen.getByLabelText("Year")).getAllByRole("option").map((o) => o.textContent);
    expect(years[0]).toBe("2031");
    expect(years[years.length - 1]).toBe("2000");
    expect(years).toHaveLength(32);
  });

  it("creates the month picked", () => {
    const { onCreate } = renderSheet();
    fireEvent.change(screen.getByLabelText("Month"), { target: { value: "11" } });
    fireEvent.change(screen.getByLabelText("Year"), { target: { value: "2004" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(onCreate).toHaveBeenCalledWith({ year: "2004", month: "11" });
  });

  it("cancels", () => {
    const { onCancel, onCreate } = renderSheet();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onCreate).not.toHaveBeenCalled();
  });
});

describe("RerunSheet", () => {
  function renderSheet() {
    const onCancel = vi.fn();
    const onConfirm = vi.fn();
    render(<RerunSheet period="March 2030" onCancel={onCancel} onConfirm={onConfirm} />);
    return { onCancel, onConfirm };
  }

  it("asks before re-running and explains what happens", () => {
    renderSheet();
    const sheet = screen.getByRole("alertdialog", { name: "Reconcile March 2030 again?" });
    expect(sheet.getAttribute("aria-describedby")).toBeTruthy();
    expect(within(sheet).getByText("Receipts that were sorted move back to the receipts folder, and Concilia reads every receipt again. This can take a while.")).toBeTruthy();
  });

  it("makes Cancel the default button", () => {
    const { onCancel, onConfirm } = renderSheet();
    const cancel = screen.getByRole("button", { name: "Cancel" });
    expect(cancel.className).toBe("default");
    expect(document.activeElement).toBe(cancel);
    expect(screen.getByRole("button", { name: "Reconcile Again" }).className).toBe("destructive");
    fireEvent.keyDown(screen.getByRole("alertdialog"), { key: "Enter" });
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("re-runs on confirm", () => {
    const { onConfirm } = renderSheet();
    fireEvent.click(screen.getByRole("button", { name: "Reconcile Again" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});
