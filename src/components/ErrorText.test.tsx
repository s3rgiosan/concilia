// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ErrorText } from "./ErrorText";

afterEach(cleanup);

describe("ErrorText", () => {
  it("shows the sentence with the backend message as a secondary line", () => {
    const { container } = render(<ErrorText error={{ kind: "io", message: "/receipts/2030/03 is locked" }} />);
    expect(container.textContent).toContain("Concilia couldn't read or write a file.");
    expect(screen.getByText("Details: /receipts/2030/03 is locked").className).toBe("error-detail");
  });

  it("shows only the sentence of a known case", () => {
    const { container } = render(<ErrorText error={{ kind: "invalid_input", message: "add a bank statement", code: "no_transactions" }} />);
    expect(container.textContent).toBe("Add a bank statement to this month, then reconcile it.");
  });
});
