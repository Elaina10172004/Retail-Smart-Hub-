import React from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { cn } from '@/lib/utils';

interface DocumentKpiCardProps {
  label: string;
  value: React.ReactNode;
  icon?: React.ReactNode;
  accentClassName?: string;
  className?: string;
}

export function DocumentKpiCard({ label, value, icon, accentClassName, className }: DocumentKpiCardProps) {
  return (
    <Card className={cn('border-gray-200 shadow-sm', className)}>
      <CardContent className="p-2.5">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="text-[11px] text-gray-500">{label}</div>
            <div className={cn('mt-1 text-base font-semibold text-gray-900', accentClassName)}>{value}</div>
          </div>
          {icon ? <div className="rounded-full bg-gray-50 p-2.5 text-gray-600">{icon}</div> : null}
        </div>
      </CardContent>
    </Card>
  );
}
