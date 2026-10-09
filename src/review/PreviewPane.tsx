import { useTranslation } from "react-i18next";
import { Icon } from "../components/Icon";
import { receiptUrl, type ReceiptMeta } from "../lib/tauri";

function isImage(path: string): boolean {
  return /\.(png|jpe?g)$/i.test(path);
}

/** The selected receipt, shown inline, with a way to open it in the system viewer. */
export function PreviewPane({
  receipt,
  onOpen,
  onClose,
}: {
  receipt: ReceiptMeta | null;
  onOpen: (receipt: ReceiptMeta) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  if (!receipt || !receipt.rel_path) {
    return (
      <aside className="preview preview--empty muted" aria-label={t("review.actions.preview")}>
        <Icon name="eye" size={28} />
        <span>{t("review.previewEmpty")}</span>
      </aside>
    );
  }
  const url = receiptUrl(receipt.rel_path);
  const name = receipt.file.split("/").pop() ?? receipt.file;
  return (
    <aside className="preview" aria-label={t("review.actions.preview")}>
      <header className="preview__bar">
        <span className="preview__name" title={receipt.file}>
          {name}
        </span>
        <button type="button" onClick={() => onOpen(receipt)}>
          {t("review.openInPreview")}
        </button>
        <button type="button" className="icon" aria-label={t("common.close")} onClick={onClose}>
          <Icon name="xmark" size={12} />
        </button>
      </header>
      {isImage(receipt.file) ? (
        <img className="preview__image" src={url} alt={name} />
      ) : (
        <iframe className="preview__frame" title={name} src={`${url}#navpanes=0`} />
      )}
    </aside>
  );
}
