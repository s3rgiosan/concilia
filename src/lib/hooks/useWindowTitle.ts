import { useEffect } from "react";
import { isPreview } from "../preview";
import { setWindowTitle } from "../tauri";

/** Shows `title` as the document title and, outside the browser preview, as the native window title. */
export function useWindowTitle(title: string) {
  useEffect(() => {
    document.title = title;
    if (!isPreview()) {
      setWindowTitle(title).catch((e) => console.error("could not set the window title", e));
    }
  }, [title]);
}
