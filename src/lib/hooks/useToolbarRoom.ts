import { useEffect, useState } from "react";

/**
 * The width the toolbar holding `slot` has for its title and trailing controls: the toolbar's
 * width less its leading area. Null until the slot exists or where ResizeObserver is missing.
 */
export function useToolbarRoom(slot: HTMLElement | null): number | null {
  const [room, setRoom] = useState<number | null>(null);

  useEffect(() => {
    const header = slot?.closest<HTMLElement>(".titlebar");
    if (!header || typeof ResizeObserver === "undefined") {
      setRoom(null);
      return;
    }
    const leading = header.querySelector<HTMLElement>(".titlebar__leading");
    const measure = () => setRoom(header.getBoundingClientRect().width - (leading?.getBoundingClientRect().width ?? 0));
    const observer = new ResizeObserver(measure);
    observer.observe(header);
    if (leading) {
      observer.observe(leading);
    }
    measure();
    return () => observer.disconnect();
  }, [slot]);

  return room;
}
