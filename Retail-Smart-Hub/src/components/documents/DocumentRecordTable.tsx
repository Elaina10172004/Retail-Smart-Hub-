import React from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

interface DocumentRecordTableProps {
  title: string;
  filters?: React.ReactNode;
  footer?: React.ReactNode;
  children: React.ReactNode;
}

export function DocumentRecordTable({ title, filters, footer, children }: DocumentRecordTableProps) {
  return (
    <Card className="border-gray-200 shadow-sm">
      <CardHeader className="rounded-t-xl border-b border-gray-100 bg-gray-50/50 py-2">
        <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
          <CardTitle className="text-base font-semibold text-gray-800">{title}</CardTitle>
          {filters ? <div className="flex w-full flex-1 flex-wrap gap-2 md:justify-end">{filters}</div> : null}
        </div>
      </CardHeader>
      <CardContent className="p-0">
        {children}
        {footer ? <div className="border-t border-gray-100 bg-gray-50/30 px-3 py-2.5">{footer}</div> : null}
      </CardContent>
    </Card>
  );
}
