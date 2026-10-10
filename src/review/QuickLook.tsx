import { useContext, useEffect, useRef, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { Icon } from "../components/Icon";
import { ExitingContext } from "../components/Presence";
import { useModal } from "../components/Sheet";
import { useLatest } from "../lib/hooks/useLatest";
import type { ReceiptMeta } from "../lib/tauri";
import { ReceiptPreview } from "./ReceiptPreview";
import { fileName } from "./receipts";

/** Quick Look's margin from the window edges and its widest size, in pixels, as Review.css sets them. */
const MARGIN = 40;
const MAX_WIDTH = 880;

/**
 * The transform that shrinks Quick Look onto `source`: the panel's centre moves onto the source's
 * centre and the panel scales to the source's width, within limits so the content stays legible.
 */
function originTransform(source: DOMRect): string {
  const width = Math.min(MAX_WIDTH, window.innerWidth - 2 * MARGIN);
  const height = window.innerHeight - 2 * MARGIN;
  if (width <= 0 || height <= 0) {
    return "scale(0.96)";
  }
  const scale = Math.min(1, Math.max(0.3, Math.min(source.width / width, source.height / height)));
  const dx = source.left + source.width / 2 - window.innerWidth / 2;
  const dy = source.top + source.height / 2 - window.innerHeight / 2;
  return `translate(${Math.round(dx)}px, ${Math.round(dy)}px) scale(${scale.toFixed(3)})`;
}

/** Where Quick Look grows from: the details column's preview, else the selected row. */
function quickLookOrigin(): string | null {
  const source = document.querySelector(".details__preview") ?? document.querySelector(".list-row--selected");
  return source ? originTransform(source.getBoundingClientRect()) : null;
}

/**
 * The selected row's receipt enlarged over the window, like Quick Look. It grows from the
 * details column's preview (or the selected row) and shrinks back into it. ↑/↓ move the selection
 * in the list behind it, so the preview follows; Esc or Space closes it, and focus returns to
 * where it was. Tab stays inside it. `name` titles it when the row has no receipt to show.
 */
export function QuickLook({
  receipt,
  name,
  onClose,
  onOpen,
  onMove,
}: {
  receipt: ReceiptMeta | null;
  name: string;
  onClose: () => void;
  onOpen: (receipt: ReceiptMeta) => void;
  onMove: (direction: 1 | -1) => void;
}) {
  const { t } = useTranslation();
  const backdrop = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const latest = useLatest({ onClose, onMove });
  const title = receipt ? fileName(receipt.file) : name;
  const exiting = useContext(ExitingContext);
  // Read once, before the panel mounts, so its first style already starts from the source.
  const [origin] = useState(quickLookOrigin);
  useModal(backdrop, panel, onClose);

  useEffect(() => {
    if (exiting) {
      return;
    }
    function onKey(e: KeyboardEvent) {
      const onButton = e.target instanceof HTMLElement && e.target.tagName === "BUTTON";
      if (e.metaKey || e.ctrlKey || e.altKey) {
        return;
      }
      switch (e.key) {
        case " ":
          if (onButton) {
            return;
          }
          latest.current.onClose();
          break;
        case "ArrowDown":
          latest.current.onMove(1);
          break;
        case "ArrowUp":
          latest.current.onMove(-1);
          break;
        default:
          return;
      }
      e.preventDefault();
      e.stopPropagation();
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [latest, exiting]);

  return (
    <div
      ref={backdrop}
      className="quicklook-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) {
          onClose();
        }
      }}
    >
      <div
        ref={panel}
        className="quicklook"
        style={origin ? ({ "--quicklook-origin": origin } as CSSProperties) : undefined}
        role="dialog"
        aria-modal="true"
        aria-label={t("review.quickLookOf", { name: title })}
        tabIndex={-1}
      >
        <header className="quicklook__bar">
          <button type="button" className="icon" aria-label={t("common.close")} title={t("common.close")} onClick={onClose}>
            <Icon name="xmark" size={12} />
          </button>
          <span className="quicklook__name" title={receipt?.file}>
            {title}
          </span>
          <button type="button" onClick={() => receipt && onOpen(receipt)} disabled={!receipt?.rel_path}>
            {t("review.openInPreview")}
          </button>
        </header>
        <ReceiptPreview receipt={receipt} />
      </div>
    </div>
  );
}
