import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { fileName } from "../lib/paths";
import { receiptUrl, type ReceiptMeta } from "../lib/tauri";
import { isImage } from "./receipts";

/**
 * A receipt's file shown inline: an image, or a PDF in a frame. With `delayMs`, a new receipt
 * replaces the shown one only once it has stayed for that long, so holding an arrow key does not
 * load every file passed. `suspended` leaves the frame empty while the same file shows elsewhere.
 */
export function ReceiptPreview({ receipt, delayMs = 0, suspended = false }: { receipt: ReceiptMeta | null; delayMs?: number; suspended?: boolean }) {
  const { t } = useTranslation();
  const [settled, setSettled] = useState(receipt);
  const delayed = delayMs > 0 && Boolean(receipt?.rel_path);

  useEffect(() => {
    if (delayMs <= 0) {
      return;
    }
    if (!delayed) {
      setSettled(receipt);
      return;
    }
    const timer = window.setTimeout(() => setSettled(receipt), delayMs);
    return () => window.clearTimeout(timer);
  }, [receipt, delayed, delayMs]);

  const shown = delayed ? (settled ?? receipt) : receipt;
  if (!shown?.rel_path) {
    return <div className="receipt-preview receipt-preview--empty">{t("review.noPreview")}</div>;
  }
  if (suspended) {
    return <div className="receipt-preview" />;
  }
  const url = receiptUrl(shown.rel_path);
  const name = fileName(shown.file);
  return (
    <div className="receipt-preview">
      {isImage(shown.file) ? (
        <img className="receipt-preview__image" src={url} alt={name} />
      ) : (
        <iframe className="receipt-preview__frame" title={t("review.previewOf", { name })} src={`${url}#navpanes=0`} />
      )}
    </div>
  );
}
