import { useEffect, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { isPreview } from "../preview";
import { subscribe } from "../tauri";
import { useLatest } from "./useLatest";

/**
 * Files dragged onto the window: whether a drag is over it, and the dropped paths passed to
 * `onDrop`. The browser preview has no file paths, so it reports nothing.
 */
export function useFileDrop(onDrop: (paths: string[]) => void, enabled = true): boolean {
  const [over, setOver] = useState(false);
  const latest = useLatest(onDrop);

  useEffect(() => {
    if (!enabled || isPreview()) {
      setOver(false);
      return;
    }
    return subscribe(
      getCurrentWebview().onDragDropEvent((event) => {
        switch (event.payload.type) {
          case "enter":
          case "over":
            setOver(true);
            break;
          case "drop":
            setOver(false);
            latest.current(event.payload.paths);
            break;
          case "leave":
          default:
            setOver(false);
            break;
        }
      }),
    );
  }, [enabled, latest]);

  return over;
}
