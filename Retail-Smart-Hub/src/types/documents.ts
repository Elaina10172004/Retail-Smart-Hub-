export type BusinessDocumentType =
  | 'procurement'
  | 'order'
  | 'arrival'
  | 'inbound'
  | 'shipping'
  | 'receivable'
  | 'receipt'
  | 'payment'
  | 'payable';

export type DocumentColumnAlign = 'left' | 'center' | 'right';

export interface DocumentPreviewField {
  label: string;
  value: string;
  emphasize?: boolean;
}

export interface DocumentPreviewColumn {
  key: string;
  label: string;
  align?: DocumentColumnAlign;
  width?: string;
}

export interface DocumentPreviewRow {
  id: string;
  values: Record<string, string>;
}

export interface DocumentPreviewRecord {
  id: string;
  type: BusinessDocumentType;
  title: string;
  documentNo: string;
  status: string;
  headerFields: DocumentPreviewField[];
  partyFields: DocumentPreviewField[];
  referenceFields?: DocumentPreviewField[];
  columns: DocumentPreviewColumn[];
  rows: DocumentPreviewRow[];
  summaryFields?: DocumentPreviewField[];
  remark?: string;
  footerNote?: string;
}
