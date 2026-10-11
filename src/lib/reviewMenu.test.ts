import { describe, expect, it, vi } from "vitest";
import { REVIEW_COMMANDS, type ReviewAvailability } from "./menuCommands";
import { createReviewMenuStore } from "./reviewMenu";

function availability(value: boolean): ReviewAvailability {
  return Object.fromEntries(REVIEW_COMMANDS.map((command) => [command, value])) as ReviewAvailability;
}

describe("createReviewMenuStore", () => {
  it("starts with nothing reported", () => {
    expect(createReviewMenuStore().get()).toEqual({ can: null, rejectKind: "removeMatch" });
  });

  it("tells listeners when the availability or the reject kind changes", () => {
    const store = createReviewMenuStore();
    const listener = vi.fn();
    store.subscribe(listener);
    store.setCan(availability(true));
    store.setRejectKind("noneOfThese");
    expect(listener).toHaveBeenCalledTimes(2);
    expect(store.get()).toEqual({ can: availability(true), rejectKind: "noneOfThese" });
  });

  it("stays quiet for values that did not change", () => {
    const store = createReviewMenuStore();
    store.setCan(availability(true));
    store.setRejectKind("needsReceipt");
    const listener = vi.fn();
    store.subscribe(listener);
    store.setCan(availability(true));
    store.setRejectKind("needsReceipt");
    expect(listener).not.toHaveBeenCalled();
  });

  it("stops telling a listener that unsubscribed", () => {
    const store = createReviewMenuStore();
    const listener = vi.fn();
    const stop = store.subscribe(listener);
    stop();
    store.setRejectKind("needsReceipt");
    expect(listener).not.toHaveBeenCalled();
  });
});
