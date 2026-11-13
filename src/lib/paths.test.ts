import { describe, expect, it } from "vitest";
import { fileName } from "./paths";

describe("fileName", () => {
  it("takes the last segment of a POSIX path", () => {
    expect(fileName("/receipts/2030/03/acme.pdf")).toBe("acme.pdf");
  });

  it("takes the last segment of a Windows path", () => {
    expect(fileName("C:\\receipts\\2030\\acme.pdf")).toBe("acme.pdf");
  });

  it("returns a bare name unchanged", () => {
    expect(fileName("acme.pdf")).toBe("acme.pdf");
  });
});
