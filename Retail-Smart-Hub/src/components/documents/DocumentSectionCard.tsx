import React from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';

interface DocumentSectionCardProps {
  title?: React.ReactNode;
  subtitle?: React.ReactNode;
  actions?: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
  headerClassName?: string;
  bodyClassName?: string;
  titleClassName?: string;
}

export function DocumentSectionCard({
  title,
  subtitle,
  actions,
  children,
  className,
  headerClassName,
  bodyClassName,
  titleClassName,
}: DocumentSectionCardProps) {
  return (
    <Card className={cn('border-gray-200 shadow-sm', className)}>
      {(title || subtitle || actions) ? (
        <CardHeader className={cn('rounded-t-xl border-b border-gray-100 bg-gray-50/50 py-2', headerClassName)}>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div className="space-y-1">
              {title ? <CardTitle className={cn('text-base font-semibold text-gray-800', titleClassName)}>{title}</CardTitle> : null}
              {subtitle ? <div className="text-xs text-gray-500">{subtitle}</div> : null}
            </div>
            {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
          </div>
        </CardHeader>
      ) : null}
      <CardContent className={cn('p-2.5', bodyClassName)}>{children}</CardContent>
    </Card>
  );
}
