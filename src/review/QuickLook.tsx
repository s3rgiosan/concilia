import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Icon } from "../components/Icon";
import { useLatest } from "../lib/hooks/useLatest";
import type { ReceiptMeta } from "../lib/tauri";
import { ReceiptPreview } from "./ReceiptPreview";
import { fileName } from "./receipts";

/**
 * A receipt enlarged over the window, like Quick Look: Esc or Space closes it, and focus returns
 * to where it was.
 */
export function QuickLook({ receipt, onClose, onOpen }: { receipt: ReceiptMeta; onClose: () => void; onOpen: (receipt: ReceiptMeta) => void }) {
  const { t } = useTranslation();
  const panel = useRef<HTMLDivElement>(null);
  const close = useLatest(onClose);
  const name = fileName(receipt.file);

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    panel.current?.focus();
    function onKey(e: KeyboardEvent) {
      const onButton = e.target instanceof HTMLElement && e.target.tagName === "BUTTON";
      if (e.key === "Escape" || (e.key === " " && !onButton)) {
        e.preventDefault();
        e.stopPropagation();
        close.current();
      }
    }
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      if (previous?.isConnected) {
        previous.focus();
      }
    };
  }, [close]);

  return (
    <div
      className="quicklook-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) {
          onClose();
        }
      }}
    >
      <div ref={panel} className="quicklook" role="dialog" aria-modal="true" aria-label={t("review.quickLookOf", { name })} tabIndex={-1}>
        <header className="quicklook__bar">
          <button type="button" className="icon" aria-label={t("common.close")} title={t("common.close")} onClick={onClose}>
            <Icon name="xmark" size={12} />
          </button>
          <span className="quicklook__name" title={receipt.file}>
            {name}
          </span>
          <button type="button" onClick={() => onOpen(receipt)} disabled={!receipt.rel_path}>
            {t("review.openInPreview")}
          </button>
        </header>
        <ReceiptPreview receipt={receipt} />
      </div>
    </div>
  );
}
