export interface ReceiptMeta {
  file: string;
  receiptUrl: string;
  amount_cents: number | null;
  confidence: string | null;
  currency: string | null;
  vendor: string | null;
  date: string | null;
  provider_used: string;
}

export interface TransactionResult {
  id: string;
  date: string;
  description: string;
  amount_cents: number;
  abs_cents: number;
  status: 'MATCHED' | 'REVIEW' | 'UNMATCHED';
  receipt_files: string[];
  receipt_meta: ReceiptMeta[];
  notes: string;
}

export interface ReviewData {
  transactions: TransactionResult[];
  unmatchedReceipts: ReceiptMeta[];
  reimbursements?: ReceiptMeta[];
}
