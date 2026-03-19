import mammoth from 'mammoth';
import * as XLSX from 'xlsx';
import type {
  AiAttachmentBlock,
  AiAttachmentKind,
  AiAttachmentLocator,
  AiAttachmentSheet,
} from '@/types/ai';
import type { ImportSourceRow } from '@/types/import';

const textLikeExtensions = new Set(['txt', 'csv']);
const spreadsheetExtensions = new Set(['xls', 'xlsx']);
const markdownExtensions = new Set(['md', 'markdown']);
const htmlExtensions = new Set(['html', 'htm']);
const documentExtensions = new Set(['pdf', 'docx']);
const imageExtensions = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif']);
const MAX_IMAGE_DIMENSION = 1568;
const MAX_IMAGE_DATA_URL_LENGTH = 1_800_000;

export interface ParsedAiAttachmentData {
  fileName: string;
  kind: AiAttachmentKind;
  mimeType?: string;
  imageDataUrl?: string;
  imageWidth?: number;
  imageHeight?: number;
  rowCount: number;
  rows: ImportSourceRow[];
  sheetCount: number;
  sheets: AiAttachmentSheet[];
  textContent?: string;
  blocks: AiAttachmentBlock[];
}

function splitDelimitedLine(line: string, delimiter: string) {
  const values: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const nextChar = line[index + 1];

    if (char === '"') {
      if (inQuotes && nextChar === '"') {
        current += '"';
        index += 1;
        continue;
      }

      inQuotes = !inQuotes;
      continue;
    }

    if (char === delimiter && !inQuotes) {
      values.push(current.trim());
      current = '';
      continue;
    }

    current += char;
  }

  values.push(current.trim());
  return values.map((value) => value.replace(/^\uFEFF/, '').trim());
}

function detectDelimiter(headerLine: string) {
  const candidates = ['\t', ',', '|', ';'];
  let selected = '';
  let maxColumns = 0;

  candidates.forEach((delimiter) => {
    const columnCount = splitDelimitedLine(headerLine, delimiter).length;
    if (columnCount > maxColumns) {
      maxColumns = columnCount;
      selected = delimiter;
    }
  });

  return maxColumns > 1 ? selected : '';
}

function compactText(value: string) {
  return value.replace(/\r/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function clipText(value: string, limit = 800) {
  if (value.length <= limit) {
    return value;
  }
  return `${value.slice(0, Math.max(0, limit - 3))}...`;
}

function buildBlockId(prefix: string, index: number) {
  return `${prefix}-${String(index + 1).padStart(3, '0')}`;
}

function normalizeRows(rows: ImportSourceRow[]) {
  return rows.filter((row) => row && typeof row === 'object' && !Array.isArray(row));
}

function buildSheetHeaders(rows: ImportSourceRow[]) {
  return Array.from(new Set(rows.flatMap((row) => Object.keys(row)))).filter(Boolean);
}

function parseDelimitedRows(rawText: string) {
  const lines = rawText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length < 2) {
    throw new Error('文本文件至少需要包含表头和一行数据。');
  }

  const delimiter = detectDelimiter(lines[0]);
  if (!delimiter) {
    throw new Error('无法识别文本分隔符，请使用逗号、制表符、分号或竖线。');
  }

  const headers = splitDelimitedLine(lines[0], delimiter);
  return lines.slice(1).map<ImportSourceRow>((line) => {
    const values = splitDelimitedLine(line, delimiter);
    return headers.reduce<ImportSourceRow>((record, header, index) => {
      if (header) {
        record[header] = values[index] ?? '';
      }
      return record;
    }, {});
  });
}

function parseMarkdownBlocks(text: string, fileName: string) {
  const normalized = compactText(text);
  const paragraphs = normalized.split(/\n\s*\n/).map((part) => part.trim()).filter(Boolean);
  const headingPath: string[] = [];
  const blocks: AiAttachmentBlock[] = [];
  let paragraphIndex = 0;

  paragraphs.forEach((paragraph) => {
    const headingMatch = paragraph.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const title = headingMatch[2].trim();
      headingPath.splice(Math.max(0, level - 1));
      headingPath[level - 1] = title;
      blocks.push({
        blockId: buildBlockId('md-heading', blocks.length),
        type: 'heading',
        text: title,
        title,
        locator: {
          fileName,
          kind: 'document',
          blockId: buildBlockId('md-heading', blocks.length),
          paragraph: paragraphIndex + 1,
          sectionTitle: title,
          headingPath: [...headingPath],
        },
      });
      return;
    }

    const blockId = buildBlockId('md-paragraph', blocks.length);
    paragraphIndex += 1;
    blocks.push({
      blockId,
      type: 'paragraph',
      text: paragraph,
      title: headingPath[headingPath.length - 1],
      locator: {
        fileName,
        kind: 'document',
        blockId,
        paragraph: paragraphIndex,
        sectionTitle: headingPath[headingPath.length - 1],
        headingPath: [...headingPath],
      },
    });
  });

  return blocks;
}

function pushHtmlBlock(
  blocks: AiAttachmentBlock[],
  fileName: string,
  type: AiAttachmentBlock['type'],
  text: string,
  locator: AiAttachmentLocator,
  title?: string,
) {
  const normalized = compactText(text);
  if (!normalized) {
    return;
  }
  const blockId = buildBlockId('html', blocks.length);
  blocks.push({
    blockId,
    type,
    text: normalized,
    title,
    locator: {
      ...locator,
      fileName,
      kind: 'document',
      blockId,
    },
  });
}

function parseHtmlBlocks(html: string, fileName: string) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');
  const blocks: AiAttachmentBlock[] = [];
  const headingPath: string[] = [];
  let paragraph = 0;
  const elements = Array.from(
    doc.body.querySelectorAll('h1,h2,h3,h4,h5,h6,p,li,blockquote,pre,table'),
  );

  elements.forEach((element) => {
    const text = compactText(element.textContent || '');
    if (!text) {
      return;
    }

    const tagName = element.tagName.toLowerCase();
    if (/^h[1-6]$/.test(tagName)) {
      const level = Number(tagName.slice(1));
      headingPath.splice(Math.max(0, level - 1));
      headingPath[level - 1] = text;
      pushHtmlBlock(
        blocks,
        fileName,
        'heading',
        text,
        {
          paragraph: paragraph + 1,
          sectionTitle: text,
          headingPath: [...headingPath],
        },
        text,
      );
      return;
    }

    paragraph += 1;
    pushHtmlBlock(
      blocks,
      fileName,
      'paragraph',
      text,
      {
        paragraph,
        sectionTitle: headingPath[headingPath.length - 1],
        headingPath: [...headingPath],
      },
      headingPath[headingPath.length - 1],
    );
  });

  return blocks;
}

function buildDocumentAttachment(
  file: File,
  textContent: string,
  blocks: AiAttachmentBlock[],
): ParsedAiAttachmentData {
  const normalizedText = compactText(textContent);
  const normalizedBlocks = blocks.filter((block) => compactText(block.text));
  return {
    fileName: file.name,
    kind: 'document',
    mimeType: file.type || undefined,
    rowCount: 0,
    rows: [],
    sheetCount: 0,
    sheets: [],
    textContent: normalizedText,
    blocks:
      normalizedBlocks.length > 0
        ? normalizedBlocks
        : [
            {
              blockId: 'doc-001',
              type: 'paragraph',
              text: clipText(normalizedText, 2400),
              locator: {
                fileName: file.name,
                kind: 'document',
                blockId: 'doc-001',
                paragraph: 1,
              },
            },
          ],
  };
}

function buildTableAttachment(file: File, rows: ImportSourceRow[]): ParsedAiAttachmentData {
  const normalizedRows = normalizeRows(rows);
  if (normalizedRows.length === 0) {
    throw new Error('文件中没有可用的数据行。');
  }

  const headers = buildSheetHeaders(normalizedRows);
  return {
    fileName: file.name,
    kind: 'table',
    mimeType: file.type || undefined,
    rowCount: normalizedRows.length,
    rows: normalizedRows,
    sheetCount: 1,
    sheets: [
      {
        name: 'Sheet1',
        rowCount: normalizedRows.length,
        headers,
        rows: normalizedRows,
      },
    ],
    blocks: [
      {
        blockId: 'table-summary-001',
        type: 'table_summary',
        text: `${file.name}: ${normalizedRows.length} rows, fields: ${headers.join(', ') || '-'}`,
        locator: {
          fileName: file.name,
          kind: 'table',
          blockId: 'table-summary-001',
          rowStart: 1,
          rowEnd: normalizedRows.length,
        },
      },
    ],
  };
}

function buildWorkbookAttachment(file: File, sheets: AiAttachmentSheet[]): ParsedAiAttachmentData {
  const normalizedSheets = sheets.filter((sheet) => sheet.rows.length > 0);
  if (normalizedSheets.length === 0) {
    throw new Error('Excel 文件中没有可读取的数据行。');
  }

  if (normalizedSheets.length === 1) {
    return {
      ...buildTableAttachment(file, normalizedSheets[0].rows),
      sheets: normalizedSheets,
      sheetCount: 1,
    };
  }

  const rows = normalizedSheets.flatMap((sheet) =>
    sheet.rows.map((row) => ({
      ...row,
      sheetName: typeof row.sheetName === 'string' && row.sheetName ? row.sheetName : sheet.name,
    })),
  );
  const rowCount = rows.length;
  const blocks = normalizedSheets.map<AiAttachmentBlock>((sheet, index) => ({
    blockId: buildBlockId('sheet-summary', index),
    type: 'sheet_summary',
    text: `${sheet.name}: ${sheet.rowCount} rows, fields: ${sheet.headers.join(', ') || '-'}`,
    title: sheet.name,
    locator: {
      fileName: file.name,
      kind: 'workbook',
      blockId: buildBlockId('sheet-summary', index),
      sheetName: sheet.name,
      rowStart: 1,
      rowEnd: sheet.rowCount,
    },
  }));

  return {
    fileName: file.name,
    kind: 'workbook',
    mimeType: file.type || undefined,
    rowCount,
    rows,
    sheetCount: normalizedSheets.length,
    sheets: normalizedSheets,
    blocks,
  };
}

function readFileAsDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      if (!result) {
        reject(new Error('无法读取图片内容。'));
        return;
      }
      resolve(result);
    };
    reader.onerror = () => {
      reject(reader.error || new Error('图片读取失败。'));
    };
    reader.readAsDataURL(file);
  });
}

function loadImage(dataUrl: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('无法解析图片内容。'));
    image.src = dataUrl;
  });
}

async function buildImageAttachment(file: File): Promise<ParsedAiAttachmentData> {
  const sourceDataUrl = await readFileAsDataUrl(file);
  const image = await loadImage(sourceDataUrl);
  const scale = Math.min(1, MAX_IMAGE_DIMENSION / Math.max(image.width || 1, image.height || 1));
  const width = Math.max(1, Math.round(image.width * scale));
  const height = Math.max(1, Math.round(image.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) {
    throw new Error('当前浏览器不支持图片附件处理。');
  }
  context.drawImage(image, 0, 0, width, height);

  const preferredMimeType = (file.type || '').trim().toLowerCase();
  let mimeType = preferredMimeType && preferredMimeType.startsWith('image/') ? preferredMimeType : 'image/jpeg';
  let quality = mimeType === 'image/png' ? undefined : 0.86;
  let imageDataUrl = canvas.toDataURL(mimeType, quality);

  if (imageDataUrl.length > MAX_IMAGE_DATA_URL_LENGTH && mimeType !== 'image/jpeg') {
    mimeType = 'image/jpeg';
    quality = 0.84;
    imageDataUrl = canvas.toDataURL(mimeType, quality);
  }

  while (imageDataUrl.length > MAX_IMAGE_DATA_URL_LENGTH && typeof quality === 'number' && quality > 0.45) {
    quality = Number((quality - 0.08).toFixed(2));
    imageDataUrl = canvas.toDataURL(mimeType, quality);
  }

  if (imageDataUrl.length > MAX_IMAGE_DATA_URL_LENGTH) {
    throw new Error('图片过大，当前会话仅支持压缩后约 1.8MB 以内的图片附件。');
  }

  return {
    fileName: file.name,
    kind: 'image',
    mimeType,
    imageDataUrl,
    imageWidth: width,
    imageHeight: height,
    rowCount: 0,
    rows: [],
    sheetCount: 0,
    sheets: [],
    blocks: [],
  };
}

async function parseSpreadsheetFile(file: File) {
  const buffer = await file.arrayBuffer();
  const workbook = XLSX.read(buffer, { type: 'array' });
  const sheets = workbook.SheetNames.map<AiAttachmentSheet>((sheetName) => {
    const sheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json<ImportSourceRow>(sheet, {
      defval: '',
      raw: false,
    });
    const normalizedRows = normalizeRows(rows);
    return {
      name: sheetName,
      rowCount: normalizedRows.length,
      headers: buildSheetHeaders(normalizedRows),
      rows: normalizedRows,
    };
  });

  return buildWorkbookAttachment(file, sheets);
}

async function parseTextDocument(file: File) {
  const rawText = await file.text();
  const normalizedText = compactText(rawText);
  if (!normalizedText) {
    throw new Error('文本文件为空。');
  }

  const extension = file.name.split('.').pop()?.toLowerCase() || '';
  if (extension === 'txt') {
    try {
      return buildTableAttachment(file, parseDelimitedRows(rawText));
    } catch {
      // Fall back to document-first parsing for free-form text attachments.
    }
  }

  const blocks = markdownExtensions.has(extension)
    ? parseMarkdownBlocks(normalizedText, file.name)
    : normalizedText.split(/\n\s*\n/).map((paragraph, index) => ({
        blockId: buildBlockId('text-paragraph', index),
        type: 'paragraph' as const,
        text: paragraph,
        locator: {
          fileName: file.name,
          kind: 'document' as const,
          blockId: buildBlockId('text-paragraph', index),
          paragraph: index + 1,
        },
      }));

  return buildDocumentAttachment(file, normalizedText, blocks);
}

async function parseHtmlDocument(file: File) {
  const html = await file.text();
  const blocks = parseHtmlBlocks(html, file.name);
  const textContent = blocks.map((block) => block.text).join('\n\n') || compactText(html);
  return buildDocumentAttachment(file, textContent, blocks);
}

async function parseDocxDocument(file: File) {
  const arrayBuffer = await file.arrayBuffer();
  const result = await mammoth.convertToHtml({ arrayBuffer });
  const blocks = parseHtmlBlocks(result.value, file.name);
  const textContent =
    blocks.map((block) => block.text).join('\n\n') ||
    compactText((await mammoth.extractRawText({ arrayBuffer })).value);
  return buildDocumentAttachment(file, textContent, blocks);
}

async function parsePdfDocument(file: File) {
  const pdfjs = await import('pdfjs-dist/build/pdf.mjs');
  if ('GlobalWorkerOptions' in pdfjs) {
    pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString();
  }

  const data = new Uint8Array(await file.arrayBuffer());
  const loadingTask = pdfjs.getDocument({
    data,
    useSystemFonts: true,
  });
  const pdf = await loadingTask.promise;
  const blocks: AiAttachmentBlock[] = [];

  for (let pageIndex = 1; pageIndex <= pdf.numPages; pageIndex += 1) {
    const page = await pdf.getPage(pageIndex);
    const textContent = await page.getTextContent();
    const pageText = compactText(
      (textContent.items as Array<{ str?: string }>)
        .map((item) => item.str || '')
        .join(' '),
    );
    if (!pageText) {
      continue;
    }
    const blockId = buildBlockId('pdf-page', blocks.length);
    blocks.push({
      blockId,
      type: 'page',
      text: pageText,
      title: `Page ${pageIndex}`,
      locator: {
        fileName: file.name,
        kind: 'document',
        blockId,
        page: pageIndex,
      },
    });
  }

  await loadingTask.destroy();
  const text = blocks.map((block) => block.text).join('\n\n');
  return buildDocumentAttachment(file, text, blocks);
}

export async function parseImportFile(file: File) {
  const extension = file.name.split('.').pop()?.toLowerCase() || '';
  if (extension === 'csv' || extension === 'txt') {
    return parseDelimitedRows(await file.text());
  }

  if (spreadsheetExtensions.has(extension)) {
    const attachment = await parseSpreadsheetFile(file);
    return attachment.rows;
  }

  throw new Error('仅支持导入 txt、csv、xls 或 xlsx 文件。');
}

export async function parseAttachmentFile(file: File): Promise<ParsedAiAttachmentData> {
  const extension = file.name.split('.').pop()?.toLowerCase() || '';

  if (extension === 'csv') {
    return buildTableAttachment(file, parseDelimitedRows(await file.text()));
  }

  if (spreadsheetExtensions.has(extension)) {
    return parseSpreadsheetFile(file);
  }

  if (textLikeExtensions.has(extension) || markdownExtensions.has(extension)) {
    return parseTextDocument(file);
  }

  if (htmlExtensions.has(extension)) {
    return parseHtmlDocument(file);
  }

  if (extension === 'docx') {
    return parseDocxDocument(file);
  }

  if (extension === 'pdf') {
    return parsePdfDocument(file);
  }

  if (imageExtensions.has(extension)) {
    return buildImageAttachment(file);
  }

  if (documentExtensions.has(extension)) {
    throw new Error(`暂不支持解析 ${extension.toUpperCase()} 附件。`);
  }

  throw new Error('仅支持 txt、md、csv、xls、xlsx、pdf、docx、html 或 htm 文件。');
}
