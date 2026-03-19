import React from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  confirmVariant?: 'default' | 'destructive';
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  open,
  title,
  message,
  confirmText = '确认',
  cancelText = '取消',
  confirmVariant = 'default',
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  if (!open) {
    return null;
  }

  const messageLines = message
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/35 p-4 backdrop-blur-[1px]">
      <Card className="w-full max-w-md border-slate-200 shadow-xl">
        <CardHeader className="border-b border-slate-100">
          <CardTitle className="text-base text-slate-900">{title}</CardTitle>
          <CardDescription>请确认后继续执行。</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4 pt-4 text-sm text-slate-700">
          <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
            {messageLines.length > 0 ? (
              <div className="space-y-1">
                {messageLines.map((line, index) => (
                  <p key={`${line}-${index}`}>{line}</p>
                ))}
              </div>
            ) : (
              <p>{message}</p>
            )}
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={onCancel}>
              {cancelText}
            </Button>
            <Button variant={confirmVariant} onClick={onConfirm}>
              {confirmText}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
