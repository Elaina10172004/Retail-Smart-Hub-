import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';

export interface ConfirmOptions {
  title?: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  confirmVariant?: 'default' | 'destructive';
}

interface PendingConfirm {
  options: Required<ConfirmOptions>;
  resolve: (result: boolean) => void;
}

const defaultOptions: Required<Omit<ConfirmOptions, 'message'>> = {
  title: '确认操作',
  confirmText: '确认',
  cancelText: '取消',
  confirmVariant: 'default',
};

function normalizeOptions(options: ConfirmOptions | string): Required<ConfirmOptions> {
  if (typeof options === 'string') {
    return {
      ...defaultOptions,
      message: options,
    };
  }

  return {
    ...defaultOptions,
    ...options,
  };
}

export function useConfirmDialog() {
  const [pending, setPending] = useState<PendingConfirm | null>(null);
  const pendingRef = useRef<PendingConfirm | null>(null);

  useEffect(() => {
    pendingRef.current = pending;
  }, [pending]);

  useEffect(() => {
    return () => {
      if (pendingRef.current) {
        pendingRef.current.resolve(false);
      }
    };
  }, []);

  const close = useCallback((result: boolean) => {
    setPending((current) => {
      if (!current) {
        return null;
      }
      current.resolve(result);
      return null;
    });
  }, []);

  const confirm = useCallback((options: ConfirmOptions | string) => {
    return new Promise<boolean>((resolve) => {
      setPending((current) => {
        if (current) {
          current.resolve(false);
        }

        return {
          options: normalizeOptions(options),
          resolve,
        };
      });
    });
  }, []);

  const confirmDialog = useMemo(
    () =>
      pending ? (
        <ConfirmDialog
          open
          title={pending.options.title}
          message={pending.options.message}
          confirmText={pending.options.confirmText}
          cancelText={pending.options.cancelText}
          confirmVariant={pending.options.confirmVariant}
          onCancel={() => {
            close(false);
          }}
          onConfirm={() => {
            close(true);
          }}
        />
      ) : null,
    [close, pending],
  );

  return {
    confirm,
    confirmDialog,
  };
}
