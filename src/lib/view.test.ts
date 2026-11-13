import { describe, expect, it } from "vitest";
import { viewFromSearch } from "./view";

describe("viewFromSearch", () => {
  it("reads the settings view", () => {
    expect(viewFromSearch("?view=settings")).toBe("settings");
  });

  it("falls back to the main view", () => {
    expect(viewFromSearch("")).toBe("main");
    expect(viewFromSearch("?view=other")).toBe("main");
  });
});
