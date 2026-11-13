import { fileName } from "../lib/paths";
import type { ReceiptMeta } from "../lib/tauri";

/** What a receipt is called in lists: its vendor, or its file name when the vendor is unknown. */
export function receiptTitle(receipt: Pick<ReceiptMeta, "file" | "vendor">): string {
  return receipt.vendor ?? fileName(receipt.file);
}

/** Whether a receipt file is shown as an image; everything else is a PDF. */
export function isImage(path: string): boolean {
  return /\.(png|jpe?g)$/i.test(path);
}
