// What the open review tells the app menu: the commands that can run and what Reject does.

import type { RejectKind, ReviewAvailability } from "./menuCommands";
import { shallowEqual } from "./shallowEqual";

export interface ReviewMenuState {
  /** What the open review can run, or null before a review has reported. */
  can: ReviewAvailability | null;
  rejectKind: RejectKind;
}

/**
 * A small external store the review writes to and the menu reads from, so a change of selection
 * reaches the menu without rendering the window that owns both.
 */
export interface ReviewMenuStore {
  subscribe: (listener: () => void) => () => void;
  get: () => ReviewMenuState;
  setCan: (can: ReviewAvailability) => void;
  setRejectKind: (kind: RejectKind) => void;
}

export function createReviewMenuStore(): ReviewMenuStore {
  let state: ReviewMenuState = { can: null, rejectKind: "removeMatch" };
  const listeners = new Set<() => void>();

  function update(next: ReviewMenuState) {
    state = next;
    for (const listener of [...listeners]) {
      listener();
    }
  }

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    get: () => state,
    setCan(can) {
      if (state.can === null || !shallowEqual(state.can, can)) {
        update({ ...state, can });
      }
    },
    setRejectKind(rejectKind) {
      if (state.rejectKind !== rejectKind) {
        update({ ...state, rejectKind });
      }
    },
  };
}
