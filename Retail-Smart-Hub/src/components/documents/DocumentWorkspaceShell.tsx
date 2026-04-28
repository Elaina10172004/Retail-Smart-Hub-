import React from 'react';
import { X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

export type DocumentWorkspaceMode = 'create' | 'edit' | 'process' | 'readonly';

export interface WorkspaceHeaderField {
  label: string;
  value: string;
  emphasize?: boolean;
}

interface DocumentWorkspaceShellProps {
  title: string;
  actions?: React.ReactNode;
  pageError?: string;
  actionMessage?: string;
  workspaceTitle?: string;
  workspaceHeaderFields?: WorkspaceHeaderField[];
  workspaceActions?: React.ReactNode;
  onCloseWorkspace?: () => void;
  workspace?: React.ReactNode;
  workspaceVariant?: 'card' | 'raw';
  children: React.ReactNode;
}

function normalizeDocumentText(value: string) {
  return value
    .replaceAll('鍗曞彿', '单号')
    .replaceAll('鏃ユ湡', '时间')
    .replaceAll('鐘舵€?', '状态')
    .replaceAll('鑽夌', '草稿')
    .replaceAll('瀹㈡埛', '客户')
    .replaceAll('鏈€夋嫨', '未选择')
    .replaceAll('渚涘簲鍟?', '供应商')
    .replaceAll('宸ヤ綔鍖?', '工作区')
    .replaceAll('鍏抽棴', '关闭');
}

function renderHeaderLine(fields: WorkspaceHeaderField[]) {
  return fields.map((field) => (
    <span key={field.label} className="whitespace-nowrap">
      <span className="text-slate-500">{normalizeDocumentText(field.label)}：</span>
      <span className={field.emphasize ? 'font-semibold text-slate-900' : 'text-slate-700'}>{normalizeDocumentText(field.value)}</span>
    </span>
  ));
}

export function DocumentWorkspaceShell({
  title,
  actions,
  pageError,
  actionMessage,
  workspaceTitle,
  workspaceHeaderFields,
  workspaceActions,
  onCloseWorkspace,
  workspace,
  workspaceVariant = 'card',
  children,
}: DocumentWorkspaceShellProps) {
  return (
    <div className="animate-in fade-in space-y-3 duration-500">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <h2 className="text-[1.65rem] font-bold tracking-tight text-gray-900">{title}</h2>
        {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
      </div>

      {pageError ? (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-700">{pageError}</div>
      ) : null}

      {actionMessage ? (
        <div className="rounded-xl border border-green-200 bg-green-50 px-4 py-2.5 text-sm text-green-700">
          {actionMessage}
        </div>
      ) : null}

      {workspaceHeaderFields && workspaceHeaderFields.length > 0 ? (
        <div className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-[11px] leading-5 text-slate-500 shadow-sm">
          <div className="flex flex-wrap gap-x-4 gap-y-1">{renderHeaderLine(workspaceHeaderFields)}</div>
        </div>
      ) : null}

      {workspace
        ? workspaceVariant === 'raw'
          ? workspace
          : (
            <Card className="border-gray-200 shadow-sm">
              <CardHeader className="rounded-t-xl border-b border-gray-100 bg-gray-50/50 py-2">
                <div className="flex items-center justify-between gap-3">
                  <CardTitle className="text-base font-semibold text-gray-800">{workspaceTitle || '工作区'}</CardTitle>
                  <div className="flex items-center gap-2">
                    {workspaceActions}
                    {onCloseWorkspace ? (
                      <Button variant="ghost" size="sm" onClick={onCloseWorkspace}>
                        <X className="mr-2 h-4 w-4" />
                        关闭
                      </Button>
                    ) : null}
                  </div>
                </div>
              </CardHeader>
              <CardContent className="pt-2.5">{workspace}</CardContent>
            </Card>
          )
        : null}

      {children}
    </div>
  );
}
