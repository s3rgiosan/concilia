import { useTranslation } from "react-i18next";
import { fileName } from "../lib/paths";
import { receiptUrl, type ReceiptMeta } from "../lib/tauri";
import { isImage } from "./receipts";

/** A receipt's file shown inline: an image, or a PDF in a frame. */
export function ReceiptPreview({ receipt }: { receipt: ReceiptMeta | null }) {
  const { t } = useTranslation();
  if (!receipt?.rel_path) {
    return <div className="receipt-preview receipt-preview--empty">{t("review.noPreview")}</div>;
  }
  const url = receiptUrl(receipt.rel_path);
  const name = fileName(receipt.file);
  return (
    <div className="receipt-preview">
      {isImage(receipt.file) ? (
        <img className="receipt-preview__image" src={url} alt={name} />
      ) : (
        <iframe className="receipt-preview__frame" title={t("review.previewOf", { name })} src={`${url}#navpanes=0`} />
      )}
    </div>
  );
}
