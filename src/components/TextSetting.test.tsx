// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TextSetting } from "./TextSetting";

afterEach(cleanup);

function field() {
  return screen.getByLabelText("Project") as HTMLInputElement;
}

describe("TextSetting", () => {
  it("saves a changed value on blur, trimmed", () => {
    const onCommit = vi.fn();
    render(<TextSetting id="p" label="Project" value="acme" onCommit={onCommit} />);
    fireEvent.focus(field());
    fireEvent.change(field(), { target: { value: "  globex " } });
    fireEvent.blur(field());
    expect(onCommit).toHaveBeenCalledWith("globex");
  });

  it("does not save an unchanged value", () => {
    const onCommit = vi.fn();
    render(<TextSetting id="p" label="Project" value="acme" onCommit={onCommit} />);
    fireEvent.focus(field());
    fireEvent.change(field(), { target: { value: "acme " } });
    fireEvent.blur(field());
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("puts the saved value back on Escape", () => {
    const onCommit = vi.fn();
    render(<TextSetting id="p" label="Project" value="acme" onCommit={onCommit} />);
    fireEvent.focus(field());
    fireEvent.change(field(), { target: { value: "globex" } });
    fireEvent.keyDown(field(), { key: "Escape" });
    expect(field().value).toBe("acme");
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("does not save on Escape when the input has real focus", () => {
    const onCommit = vi.fn();
    render(<TextSetting id="p" label="Project" value="acme" onCommit={onCommit} />);
    act(() => field().focus());
    fireEvent.change(field(), { target: { value: "globex" } });
    fireEvent.keyDown(field(), { key: "Escape" });
    expect(document.activeElement).not.toBe(field());
    expect(field().value).toBe("acme");
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("follows the value while not editing", () => {
    const { rerender } = render(<TextSetting id="p" label="Project" value="acme" onCommit={() => undefined} />);
    rerender(<TextSetting id="p" label="Project" value="initech" onCommit={() => undefined} />);
    expect(field().value).toBe("initech");
  });
});
