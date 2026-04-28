export type AiImportTarget = 'auto' | 'customer' | 'product' | 'order' | 'procurement';
export type AiAttachmentKind = 'document' | 'table' | 'workbook' | 'image';

export interface AiDocumentLocator {
  [key: string]: unknown;
  attachmentId?: string;
  fileName?: string;
  kind?: AiAttachmentKind;
  page?: number;
  paragraph?: number;
  sectionTitle?: string;
  headingPath?: string[];
  blockId?: string;
  sheetName?: string;
  rowStart?: number;
  rowEnd?: number;
  columnStart?: number;
  columnEnd?: number;
  cellRange?: string;
  charStart?: number;
  charEnd?: number;
}

export interface AiDocumentBlock {
  blockId: string;
  type: 'paragraph' | 'heading' | 'page' | 'sheet_summary' | 'table_summary';
  text: string;
  title?: string;
  locator: AiDocumentLocator;
}

export interface AiDocumentSheet {
  name: string;
  rowCount?: number;
  headers: string[];
  rows: Array<Record<string, unknown>>;
}

export interface AiDocumentAttachment {
  id?: string;
  fileName: string;
  target: AiImportTarget;
  kind?: AiAttachmentKind;
  mimeType?: string;
  imageDataUrl?: string;
  imageWidth?: number;
  imageHeight?: number;
  rowCount?: number;
  rows: Array<Record<string, unknown>>;
  sheetCount?: number;
  sheets?: AiDocumentSheet[];
  textContent?: string;
  blocks?: AiDocumentBlock[];
}

function compactText(value: unknown) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

function safeRows(rows: Array<Record<string, unknown>> | undefined) {
  return (rows ?? []).filter((row) => row && typeof row === 'object' && !Array.isArray(row));
}

function sampleRow(rows: Array<Record<string, unknown>>) {
  const row = rows[0];
  if (!row) {
    return '';
  }
  return Object.entries(row)
    .slice(0, 8)
    .map(([key, value]) => `${key}=${compactText(value).slice(0, 48)}`)
    .join('; ');
}

function safeBlocks(blocks: AiDocumentAttachment['blocks']) {
  return (blocks ?? []).filter(
    (block): block is AiDocumentBlock =>
      Boolean(block) &&
      typeof block === 'object' &&
      typeof block.blockId === 'string' &&
      typeof block.text === 'string' &&
      Boolean(block.text.trim()),
  );
}

function summarizeAttachment(attachment: AiDocumentAttachment, index: number) {
  const lines: string[] = [];
  const rows = safeRows(attachment.rows);
  const sheets = attachment.sheets ?? [];
  const blocks = safeBlocks(attachment.blocks);
  const kind = attachment.kind || (rows.length > 0 ? 'table' : 'document');
  lines.push(
    `${index}. ${attachment.fileName} | target=${attachment.target || 'auto'} | kind=${kind} | rows=${rows.length} | sheets=${sheets.length}`,
  );

  if (rows.length > 0) {
    lines.push(`Sample row: ${sampleRow(rows)}`);
  }

  sheets.slice(0, 3).forEach((sheet) => {
    const sheetRows = safeRows(sheet.rows);
    lines.push(
      `Sheet ${sheet.name}: rows=${sheet.rowCount ?? sheetRows.length}, headers=${(sheet.headers ?? []).slice(0, 12).join(', ')}`,
    );
    const sample = sampleRow(sheetRows);
    if (sample) {
      lines.push(`Sheet sample: ${sample}`);
    }
  });

  blocks.slice(0, 5).forEach((block) => {
    const location =
      typeof block.locator?.page === 'number'
        ? `page ${block.locator.page}`
        : typeof block.locator?.sheetName === 'string'
          ? `sheet ${block.locator.sheetName}`
          : block.type;
    lines.push(`Excerpt ${location}: ${compactText(block.text).slice(0, 360)}`);
  });

  if (blocks.length === 0 && attachment.textContent) {
    compactText(attachment.textContent)
      .split(/\n{2,}/)
      .map((item) => item.trim())
      .filter(Boolean)
      .slice(0, 3)
      .forEach((item) => lines.push(`Excerpt: ${item.slice(0, 360)}`));
  }

  if (kind === 'image' || attachment.imageDataUrl) {
    const dimensions =
      typeof attachment.imageWidth === 'number' && typeof attachment.imageHeight === 'number'
        ? `${attachment.imageWidth}x${attachment.imageHeight}`
        : 'unknown size';
    lines.push(`Image metadata: mime=${attachment.mimeType || 'image'}, size=${dimensions}`);
  }

  return lines;
}

export function buildAttachmentContext(attachments: AiDocumentAttachment[]) {
  if (!Array.isArray(attachments) || attachments.length === 0) {
    return '';
  }

  return [
    `Uploaded attachments: ${attachments.length}`,
    'Attachments are evidence/context. For imports, the model extracts fields and uses typed pending-action tools.',
    ...attachments.flatMap((attachment, index) => summarizeAttachment(attachment, index + 1)),
  ].join('\n');
}
