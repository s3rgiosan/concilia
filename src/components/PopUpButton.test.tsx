// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ActionPopUpButton, PopUpButton, PullDownButton } from "./PopUpButton";

afterEach(cleanup);

const OPTIONS = [
  { value: 30, label: "30 seconds" },
  { value: 60, label: "1 minute" },
];

describe("PopUpButton", () => {
  it("shows the label of the current value and lists every option", () => {
    const { container } = render(<PopUpButton value={60} options={OPTIONS} onChange={vi.fn()} label="Interval" />);
    expect(container.querySelector(".popup-button__label")?.textContent).toBe("1 minute");
    expect(screen.getAllByRole("option")).toHaveLength(2);
    expect((screen.getByLabelText("Interval") as HTMLSelectElement).value).toBe("60");
  });

  it("shows an empty label when the value matches no option", () => {
    const { container } = render(<PopUpButton value={5} options={OPTIONS} onChange={vi.fn()} label="Interval" />);
    expect(container.querySelector(".popup-button__label")?.textContent).toBe("");
  });

  it("passes the typed value of the picked option", () => {
    const onChange = vi.fn();
    render(<PopUpButton value={60} options={OPTIONS} onChange={onChange} label="Interval" id="interval" />);
    fireEvent.change(screen.getByLabelText("Interval"), { target: { value: "30" } });
    expect(onChange).toHaveBeenCalledWith(30);
  });

  it("works with string values", () => {
    const onChange = vi.fn();
    render(
      <PopUpButton
        value="a"
        options={[
          { value: "a", label: "Alpha" },
          { value: "b", label: "Beta" },
        ]}
        onChange={onChange}
        label="Letter"
      />,
    );
    fireEvent.change(screen.getByLabelText("Letter"), { target: { value: "b" } });
    expect(onChange).toHaveBeenCalledWith("b");
  });

  it("ignores a change to a value that is not an option", () => {
    const onChange = vi.fn();
    render(<PopUpButton value={60} options={OPTIONS} onChange={onChange} label="Interval" />);
    const select = screen.getByLabelText("Interval") as HTMLSelectElement;
    const stray = document.createElement("option");
    stray.value = "999";
    select.appendChild(stray);
    fireEvent.change(select, { target: { value: "999" } });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("marks itself and the select disabled", () => {
    const { container } = render(<PopUpButton value={60} options={OPTIONS} onChange={vi.fn()} label="Interval" disabled />);
    expect(container.querySelector(".popup-button--disabled")).toBeTruthy();
    expect((screen.getByLabelText("Interval") as HTMLSelectElement).disabled).toBe(true);
  });
});

describe("ActionPopUpButton", () => {
  it("opens a menu under itself and runs the chosen action", () => {
    const removeAll = vi.fn();
    render(<ActionPopUpButton actions={[{ label: "Remove All…", onSelect: removeAll }]} />);
    const button = screen.getByRole("button", { name: "More Actions" });
    expect(button.getAttribute("aria-haspopup")).toBe("menu");
    fireEvent.click(button);
    fireEvent.click(screen.getByRole("menuitem", { name: "Remove All…" }));
    expect(removeAll).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(button);
  });

  it("is disabled when asked or when every action is unavailable", () => {
    const { rerender } = render(<ActionPopUpButton label="Actions" disabled actions={[{ label: "Go", onSelect: vi.fn() }]} />);
    expect((screen.getByRole("button", { name: "Actions" }) as HTMLButtonElement).disabled).toBe(true);
    rerender(<ActionPopUpButton label="Actions" actions={[{ label: "Go", onSelect: vi.fn(), disabled: true }]} />);
    expect((screen.getByRole("button", { name: "Actions" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows unavailable actions disabled", () => {
    const go = vi.fn();
    render(
      <ActionPopUpButton
        actions={[
          { label: "Go", onSelect: go, disabled: true },
          { label: "Stay", onSelect: vi.fn() },
        ]}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "More Actions" }));
    expect((screen.getByRole("menuitem", { name: "Go" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("PullDownButton", () => {
  it("shows its label and runs the chosen action", () => {
    const refund = vi.fn();
    render(
      <PullDownButton
        label="No Receipt Needed"
        actions={[
          { label: "Bank fee", onSelect: vi.fn() },
          { label: "Refund", onSelect: refund },
        ]}
      />,
    );
    const button = screen.getByRole("button", { name: "No Receipt Needed" });
    expect(button.getAttribute("aria-haspopup")).toBe("menu");
    fireEvent.click(button);
    fireEvent.click(screen.getByRole("menuitem", { name: "Refund" }));
    expect(refund).toHaveBeenCalledTimes(1);
  });

  it("is disabled when asked", () => {
    render(<PullDownButton label="Pick" disabled actions={[{ label: "Go", onSelect: vi.fn() }]} />);
    expect((screen.getByRole("button", { name: "Pick" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("ActionPopUpButton borderless", () => {
  it("marks itself borderless", () => {
    const { container } = render(<ActionPopUpButton borderless actions={[{ label: "Go", onSelect: vi.fn() }]} />);
    expect(container.querySelector(".action-popup--borderless")).toBeTruthy();
  });
});
