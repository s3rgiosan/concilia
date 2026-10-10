// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Toolbar, ToolbarPortal } from "./Toolbar";

afterEach(cleanup);

function header(container: HTMLElement): HTMLElement {
  return container.querySelector("header") as HTMLElement;
}

describe("Toolbar", () => {
  it("shows the title, subtitle and both slots", () => {
    render(
      <Toolbar
        leading={<button type="button">Toggle</button>}
        title="March 2030"
        subtitle="In review · 6 left"
        trailing={<button type="button">Reconcile</button>}
      />,
    );
    expect(screen.getByRole("heading", { level: 1, name: "March 2030" })).toBeTruthy();
    expect(screen.getByText("In review · 6 left")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Toggle" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reconcile" })).toBeTruthy();
  });

  it("drags the window from its empty parts only", () => {
    const { container } = render(
      <Toolbar leading={<button type="button">Toggle</button>} title="March 2030" subtitle="Ready" trailing={<button type="button">Go</button>} />,
    );
    const regions = [...container.querySelectorAll("[data-tauri-drag-region]")].map((el) => el.className || el.tagName);
    expect(regions).toEqual([
      "titlebar titlebar--inset",
      "titlebar__leading",
      "titlebar__heading",
      "titlebar__title",
      "titlebar__subtitle",
      "titlebar__trailing",
    ]);
    for (const button of screen.getAllByRole("button")) {
      expect(button.hasAttribute("data-tauri-drag-region")).toBe(false);
    }
  });

  it("leaves room for the traffic lights on macOS", () => {
    const { container } = render(<Toolbar title="March 2030" />);
    expect(header(container).classList.contains("titlebar--inset")).toBe(true);
  });

  it("sizes the leading area to the sidebar", () => {
    const { container } = render(<Toolbar title="March 2030" leadingWidth={220} />);
    const leading = container.querySelector(".titlebar__leading") as HTMLElement;
    expect(leading.style.width).toBe("220px");
    expect(leading.classList.contains("titlebar__leading--sidebar")).toBe(true);
  });

  it("can drop its title, subtitle and separator", () => {
    const { container } = render(<Toolbar separator={false} />);
    expect(screen.queryByRole("heading")).toBeNull();
    expect(container.querySelector(".titlebar__subtitle")).toBeNull();
    expect(container.querySelector(".titlebar__trailing")).toBeNull();
    expect(header(container).classList.contains("titlebar--plain")).toBe(true);
  });
});

describe("ToolbarPortal", () => {
  it("renders into its slot once the slot exists", () => {
    const slot = document.createElement("div");
    document.body.appendChild(slot);
    const { rerender } = render(<ToolbarPortal target={null}>In review</ToolbarPortal>);
    expect(slot.textContent).toBe("");
    rerender(<ToolbarPortal target={slot}>In review</ToolbarPortal>);
    expect(slot.textContent).toBe("In review");
    slot.remove();
  });
});

