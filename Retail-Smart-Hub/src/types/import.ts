export interface ImportSourceRow {
  [key: string]: string | number | boolean | null | undefined;
}

export interface ImportRowError {
  rowNumber: number;
  identifier: string;
  reason: string;
}

export interface ImportBatchResult {
  totalCount: number;
  createdCount: number;
  skippedCount: number;
  errorCount: number;
  createdIds: string[];
  errors: ImportRowError[];
}
