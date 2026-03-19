export interface CsvColumn<T> {
  header: string;
  value: (row: T) => string | number | boolean | null | undefined;
}

function escapeCsvValue(value: string | number | boolean | null | undefined) {
  const text = value == null ? '' : String(value);
  if (text.includes('"') || text.includes(',') || text.includes('\n')) {
    return `"${text.replaceAll('"', '""')}"`;
  }

  return text;
}

function triggerDownload(filename: string, content: string, mimeType: string) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

export function downloadCsv<T>(filename: string, columns: CsvColumn<T>[], rows: T[]) {
  const header = columns.map((column) => escapeCsvValue(column.header)).join(',');
  const body = rows
    .map((row) => columns.map((column) => escapeCsvValue(column.value(row))).join(','))
    .join('\n');
  const content = `\uFEFF${header}\n${body}`;

  triggerDownload(filename, content, 'text/csv;charset=utf-8;');
}

export function downloadTextFile(filename: string, content: string) {
  triggerDownload(filename, content, 'text/plain;charset=utf-8;');
}
