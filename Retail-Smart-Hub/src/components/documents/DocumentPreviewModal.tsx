import React, { useEffect, useMemo, useState } from 'react';
import { Printer, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { DocumentColumnAlign, DocumentPreviewField, DocumentPreviewRecord } from '@/types/documents';

interface DocumentPreviewModalProps {
  documents: DocumentPreviewRecord[];
  isOpen: boolean;
  initialActiveId?: string;
  onClose: () => void;
}

function escapeHtml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function alignClass(align: DocumentColumnAlign = 'left') {
  if (align === 'center') {
    return 'text-center';
  }

  if (align === 'right') {
    return 'text-right';
  }

  return 'text-left';
}

function buildFieldMarkup(fields: DocumentPreviewField[]) {
  return fields
    .map(
      (field) => `
        <div class="meta-card">
          <div class="meta-label">${escapeHtml(field.label)}</div>
          <div class="meta-value${field.emphasize ? ' emphasize' : ''}">${escapeHtml(field.value)}</div>
        </div>
      `,
    )
    .join('');
}

function buildPrintHtml(document: DocumentPreviewRecord) {
  const headers = document.columns
    .map(
      (column) =>
        `<th style="${column.width ? `width:${column.width};` : ''}text-align:${column.align || 'left'}">${escapeHtml(column.label)}</th>`,
    )
    .join('');
  const rows = document.rows
    .map((row) => {
      const cells = document.columns
        .map((column) => {
          const value = row.values[column.key] || '-';
          return `<td style="text-align:${column.align || 'left'}">${escapeHtml(value)}</td>`;
        })
        .join('');
      return `<tr>${cells}</tr>`;
    })
    .join('');
  const summary = (document.summaryFields || [])
    .map(
      (field) => `
        <div class="summary-row">
          <span>${escapeHtml(field.label)}</span>
          <strong>${escapeHtml(field.value)}</strong>
        </div>
      `,
    )
    .join('');

  return `
    <!doctype html>
    <html lang="zh-CN">
      <head>
        <meta charset="utf-8" />
        <title>${escapeHtml(document.title)} - ${escapeHtml(document.documentNo)}</title>
        <style>
          body {
            margin: 0;
            font-family: "Microsoft YaHei", "PingFang SC", sans-serif;
            background: #f3f4f6;
            color: #0f172a;
          }
          .page {
            width: 210mm;
            min-height: 297mm;
            margin: 0 auto;
            background: #ffffff;
            padding: 18mm 16mm;
            box-sizing: border-box;
          }
          .title {
            text-align: center;
            font-size: 30px;
            font-weight: 700;
            letter-spacing: 6px;
            margin-bottom: 10px;
          }
          .doc-head {
            display: flex;
            justify-content: space-between;
            align-items: flex-end;
            margin-bottom: 18px;
            border-bottom: 2px solid #dbe4f0;
            padding-bottom: 12px;
          }
          .doc-no {
            font-size: 15px;
            color: #475569;
          }
          .status-pill {
            display: inline-block;
            border: 1px solid #cbd5e1;
            border-radius: 999px;
            padding: 4px 10px;
            font-size: 12px;
            color: #0f172a;
          }
          .section-title {
            font-size: 13px;
            font-weight: 700;
            color: #334155;
            margin: 18px 0 10px;
          }
          .meta-grid {
            display: grid;
            grid-template-columns: repeat(4, minmax(0, 1fr));
            gap: 10px;
          }
          .meta-card {
            border: 1px solid #dbe4f0;
            border-radius: 8px;
            padding: 10px 12px;
            min-height: 54px;
          }
          .meta-label {
            font-size: 11px;
            color: #64748b;
            margin-bottom: 6px;
          }
          .meta-value {
            font-size: 14px;
            color: #0f172a;
            word-break: break-word;
          }
          .meta-value.emphasize {
            font-weight: 700;
          }
          table {
            width: 100%;
            border-collapse: collapse;
            margin-top: 10px;
          }
          th, td {
            border: 1px solid #cbd5e1;
            padding: 10px 12px;
            font-size: 12px;
            vertical-align: middle;
          }
          th {
            background: #f8fafc;
            font-weight: 700;
            color: #334155;
          }
          .summary-box {
            margin-top: 16px;
            margin-left: auto;
            width: 280px;
            border: 1px solid #dbe4f0;
            border-radius: 8px;
            padding: 10px 12px;
          }
          .summary-row {
            display: flex;
            justify-content: space-between;
            gap: 12px;
            font-size: 13px;
            color: #0f172a;
          }
          .summary-row + .summary-row {
            margin-top: 8px;
          }
          .remark-box {
            margin-top: 18px;
            border: 1px solid #dbe4f0;
            border-radius: 8px;
            padding: 12px;
            min-height: 72px;
            font-size: 13px;
            line-height: 1.7;
            color: #334155;
            white-space: pre-wrap;
          }
          .sign-row {
            display: grid;
            grid-template-columns: repeat(3, minmax(0, 1fr));
            gap: 16px;
            margin-top: 28px;
          }
          .sign-box {
            border-top: 1px solid #94a3b8;
            padding-top: 10px;
            font-size: 12px;
            color: #475569;
          }
          .footer {
            margin-top: 18px;
            text-align: right;
            font-size: 11px;
            color: #94a3b8;
          }
          @page {
            size: A4;
            margin: 10mm;
          }
        </style>
      </head>
      <body>
        <div class="page">
          <div class="title">${escapeHtml(document.title)}</div>
          <div class="doc-head">
            <div class="doc-no">单据编号：${escapeHtml(document.documentNo)}</div>
            <div class="status-pill">${escapeHtml(document.status)}</div>
          </div>

          <div class="section-title">单据头信息</div>
          <div class="meta-grid">${buildFieldMarkup(document.headerFields)}</div>

          <div class="section-title">业务对象</div>
          <div class="meta-grid">${buildFieldMarkup(document.partyFields)}</div>

          ${
            document.referenceFields && document.referenceFields.length > 0
              ? `<div class="section-title">关联信息</div><div class="meta-grid">${buildFieldMarkup(document.referenceFields)}</div>`
              : ''
          }

          <div class="section-title">商品明细</div>
          <table>
            <thead><tr>${headers}</tr></thead>
            <tbody>${rows}</tbody>
          </table>

          ${
            document.summaryFields && document.summaryFields.length > 0
              ? `<div class="summary-box">${summary}</div>`
              : ''
          }

          ${
            document.remark
              ? `<div class="section-title">备注</div><div class="remark-box">${escapeHtml(document.remark)}</div>`
              : ''
          }

          <div class="sign-row">
            <div class="sign-box">制单人签字：</div>
            <div class="sign-box">业务确认：</div>
            <div class="sign-box">仓库 / 财务：</div>
          </div>

          <div class="footer">${escapeHtml(document.footerNote || 'Retail Smart Hub')}</div>
        </div>
      </body>
    </html>
  `;
}

export function DocumentPreviewModal({
  documents,
  isOpen,
  initialActiveId,
  onClose,
}: DocumentPreviewModalProps) {
  const [activeId, setActiveId] = useState('');
  const [isPrintPreviewOpen, setIsPrintPreviewOpen] = useState(false);

  useEffect(() => {
    if (!isOpen || documents.length === 0) {
      return;
    }

    const nextActiveId =
      (initialActiveId && documents.some((item) => item.id === initialActiveId) ? initialActiveId : '') ||
      documents[0]?.id ||
      '';
    setActiveId(nextActiveId);
  }, [documents, initialActiveId, isOpen]);

  useEffect(() => {
    if (!isOpen) {
      setIsPrintPreviewOpen(false);
      return;
    }

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (isPrintPreviewOpen) {
          setIsPrintPreviewOpen(false);
          return;
        }

        onClose();
      }
    };

    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [isOpen, isPrintPreviewOpen, onClose]);

  const activeDocument = useMemo(
    () => documents.find((item) => item.id === activeId) || documents[0] || null,
    [activeId, documents],
  );
  const printPreviewHtml = useMemo(
    () => (activeDocument ? buildPrintHtml(activeDocument) : ''),
    [activeDocument],
  );

  if (!isOpen || !activeDocument) {
    return null;
  }

  const handlePrint = () => {
    const printableHtml = buildPrintHtml(activeDocument);

    if (window.desktopShell?.documents?.printHtml) {
      void window.desktopShell.documents
        .printHtml(printableHtml)
        .catch((error) => {
          const message = error instanceof Error ? error.message : '打印失败，请稍后重试。';
          window.alert(message);
        });
      return;
    }

    const iframe = document.createElement('iframe');
    iframe.setAttribute('aria-hidden', 'true');
    iframe.style.position = 'fixed';
    iframe.style.right = '0';
    iframe.style.bottom = '0';
    iframe.style.width = '0';
    iframe.style.height = '0';
    iframe.style.border = '0';
    iframe.style.visibility = 'hidden';

    let cleanupTimer = 0;
    const cleanup = () => {
      if (cleanupTimer) {
        window.clearTimeout(cleanupTimer);
      }
      iframe.remove();
    };

    iframe.onload = () => {
      const frameWindow = iframe.contentWindow;
      if (!frameWindow) {
        cleanup();
        window.alert('当前环境不支持打印，请稍后重试。');
        return;
      }

      frameWindow.addEventListener(
        'afterprint',
        () => {
          cleanup();
        },
        { once: true },
      );

      frameWindow.focus();
      window.setTimeout(() => {
        frameWindow.print();
        cleanupTimer = window.setTimeout(cleanup, 1500);
      }, 0);
    };

    iframe.srcdoc = printableHtml;
    document.body.appendChild(iframe);
  };

  const handleOpenPrintPreview = () => {
    setIsPrintPreviewOpen(true);
  };

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-slate-950/45 p-4 backdrop-blur-[2px]">
      <div className="flex h-[92vh] w-full max-w-7xl flex-col overflow-hidden rounded-[28px] border border-slate-200 bg-slate-100 shadow-2xl">
        <div className="flex items-center justify-between border-b border-slate-200 bg-white px-6 py-4">
          <div>
            <div className="text-sm font-medium text-slate-500">真实单据预览</div>
            <div className="mt-1 text-lg font-semibold text-slate-900">
              {activeDocument.title} · {activeDocument.documentNo}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              className="border-slate-300 text-slate-700 shadow-sm transition-all hover:border-blue-300 hover:bg-blue-50 hover:text-blue-700 hover:shadow-md"
              onClick={handleOpenPrintPreview}
              title="打印预览"
              aria-label="打印预览"
            >
              <Printer className="mr-2 h-4 w-4" />
              打印
            </Button>
            <Button variant="ghost" size="icon" onClick={onClose} aria-label="关闭单据预览">
              <X className="h-5 w-5" />
            </Button>
          </div>
        </div>

        {documents.length > 1 ? (
          <div className="flex flex-wrap gap-2 border-b border-slate-200 bg-slate-50 px-6 py-3">
            {documents.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => setActiveId(item.id)}
                className={`rounded-full border px-3 py-1.5 text-sm transition-colors ${
                  item.id === activeDocument.id
                    ? 'border-blue-300 bg-blue-600 text-white'
                    : 'border-slate-300 bg-white text-slate-600 hover:border-slate-400 hover:text-slate-900'
                }`}
              >
                {item.documentNo}
              </button>
            ))}
          </div>
        ) : null}

        <div className="flex-1 overflow-auto p-6">
          <div className="mx-auto w-full max-w-[820px] rounded-[24px] border border-slate-200 bg-white px-10 py-10 shadow-[0_24px_80px_rgba(15,23,42,0.08)]">
            <div className="border-b-2 border-slate-200 pb-5">
              <div className="text-center text-[2rem] font-bold tracking-[0.45em] text-slate-900">
                {activeDocument.title}
              </div>
              <div className="mt-5 flex items-end justify-between gap-4">
                <div className="text-sm text-slate-500">单据编号：{activeDocument.documentNo}</div>
                <div className="rounded-full border border-slate-300 px-3 py-1 text-xs font-semibold text-slate-700">
                  {activeDocument.status}
                </div>
              </div>
            </div>

            <div className="mt-6 space-y-6">
              <section>
                <h3 className="text-sm font-semibold text-slate-800">单据头信息</h3>
                <div className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                  {activeDocument.headerFields.map((field) => (
                    <div key={`${activeDocument.id}-${field.label}`} className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
                      <div className="text-xs text-slate-500">{field.label}</div>
                      <div className={`mt-2 text-sm text-slate-900 ${field.emphasize ? 'font-semibold' : 'font-medium'}`}>
                        {field.value}
                      </div>
                    </div>
                  ))}
                </div>
              </section>

              <section>
                <h3 className="text-sm font-semibold text-slate-800">业务对象</h3>
                <div className="mt-3 grid gap-3 md:grid-cols-2">
                  {activeDocument.partyFields.map((field) => (
                    <div key={`${activeDocument.id}-${field.label}`} className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
                      <div className="text-xs text-slate-500">{field.label}</div>
                      <div className={`mt-2 text-sm text-slate-900 ${field.emphasize ? 'font-semibold' : 'font-medium'}`}>
                        {field.value}
                      </div>
                    </div>
                  ))}
                </div>
              </section>

              {activeDocument.referenceFields && activeDocument.referenceFields.length > 0 ? (
                <section>
                  <h3 className="text-sm font-semibold text-slate-800">关联信息</h3>
                  <div className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                    {activeDocument.referenceFields.map((field) => (
                      <div key={`${activeDocument.id}-${field.label}`} className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
                        <div className="text-xs text-slate-500">{field.label}</div>
                        <div className={`mt-2 text-sm text-slate-900 ${field.emphasize ? 'font-semibold' : 'font-medium'}`}>
                          {field.value}
                        </div>
                      </div>
                    ))}
                  </div>
                </section>
              ) : null}

              <section>
                <h3 className="text-sm font-semibold text-slate-800">商品明细</h3>
                <div className="mt-3 overflow-hidden rounded-2xl border border-slate-200">
                  <table className="min-w-full border-collapse">
                    <thead>
                      <tr className="bg-slate-50">
                        {activeDocument.columns.map((column) => (
                          <th
                            key={`${activeDocument.id}-${column.key}`}
                            className={`border-b border-slate-200 px-4 py-3 text-xs font-semibold text-slate-600 ${alignClass(column.align)}`}
                            style={column.width ? { width: column.width } : undefined}
                          >
                            {column.label}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {activeDocument.rows.map((row) => (
                        <tr key={row.id} className="border-b border-slate-100 last:border-b-0">
                          {activeDocument.columns.map((column) => (
                            <td
                              key={`${row.id}-${column.key}`}
                              className={`px-4 py-3 text-sm text-slate-700 ${alignClass(column.align)}`}
                            >
                              {row.values[column.key] || '-'}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>

              {activeDocument.summaryFields && activeDocument.summaryFields.length > 0 ? (
                <section className="flex justify-end">
                  <div className="w-full max-w-[320px] rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
                    {activeDocument.summaryFields.map((field) => (
                      <div key={`${activeDocument.id}-${field.label}`} className="flex items-center justify-between gap-3 py-1.5 text-sm text-slate-700">
                        <span>{field.label}</span>
                        <span className={field.emphasize ? 'font-semibold text-slate-900' : 'font-medium text-slate-900'}>
                          {field.value}
                        </span>
                      </div>
                    ))}
                  </div>
                </section>
              ) : null}

              {activeDocument.remark ? (
                <section>
                  <h3 className="text-sm font-semibold text-slate-800">备注</h3>
                  <div className="mt-3 min-h-24 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm leading-7 whitespace-pre-wrap text-slate-700">
                    {activeDocument.remark}
                  </div>
                </section>
              ) : null}

              <section className="grid gap-4 pt-4 md:grid-cols-3">
                <div className="border-t border-slate-300 pt-3 text-sm text-slate-500">制单人签字：</div>
                <div className="border-t border-slate-300 pt-3 text-sm text-slate-500">业务确认：</div>
                <div className="border-t border-slate-300 pt-3 text-sm text-slate-500">仓库 / 财务：</div>
              </section>

              <div className="text-right text-xs text-slate-400">
                {activeDocument.footerNote || 'Retail Smart Hub'}
              </div>
            </div>
          </div>
        </div>

        {isPrintPreviewOpen ? (
          <div className="fixed inset-0 z-[80] flex items-center justify-center bg-slate-950/55 p-4 backdrop-blur-[3px]">
            <div className="flex h-[94vh] w-full max-w-6xl flex-col overflow-hidden rounded-[28px] border border-slate-200 bg-slate-100 shadow-2xl">
              <div className="flex items-center justify-between border-b border-slate-200 bg-white px-6 py-4">
                <div>
                  <div className="text-sm font-medium text-slate-500">打印预览</div>
                  <div className="mt-1 text-lg font-semibold text-slate-900">
                    {activeDocument.title} · {activeDocument.documentNo}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    className="border-slate-300 text-slate-700 shadow-sm transition-all hover:border-blue-300 hover:bg-blue-50 hover:text-blue-700 hover:shadow-md"
                    onClick={handlePrint}
                  >
                    <Printer className="mr-2 h-4 w-4" />
                    打印
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => setIsPrintPreviewOpen(false)}
                    aria-label="关闭打印预览"
                  >
                    <X className="h-5 w-5" />
                  </Button>
                </div>
              </div>

              <div className="border-b border-slate-200 bg-slate-50 px-6 py-3 text-sm text-slate-500">
                预览展示最终纸张排版，确认无误后再执行打印。
              </div>

              <div className="flex-1 overflow-auto bg-slate-200/70 p-6">
                <div className="mx-auto flex max-w-[920px] justify-center">
                  <iframe
                    title={`打印预览 - ${activeDocument.documentNo}`}
                    srcDoc={printPreviewHtml}
                    className="w-full rounded-[24px] border border-slate-300 bg-white shadow-[0_28px_80px_rgba(15,23,42,0.16)]"
                    style={{ minHeight: '1240px' }}
                  />
                </div>
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
