import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Icon } from "../components/Icon";
import { useModal } from "../components/Sheet";
import { useLatest } from "../lib/hooks/useLatest";
import type { ReceiptMeta } from "../lib/tauri";
import { ReceiptPreview } from "./ReceiptPreview";
import { fileName } from "./receipts";

/**
 * The selected row's receipt enlarged over the window, like Quick Look. ↑/↓ move the selection
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
  useModal(backdrop, panel, onClose);

  useEffect(() => {
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
  }, [latest]);

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
      <div ref={panel} className="quicklook" role="dialog" aria-modal="true" aria-label={t("review.quickLookOf", { name: title })} tabIndex={-1}>
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
