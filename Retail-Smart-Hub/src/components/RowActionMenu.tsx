import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { LucideIcon } from 'lucide-react';
import { MoreHorizontal } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export interface RowActionMenuItem {
  id: string;
  label: string;
  icon?: LucideIcon;
  onSelect: () => void;
  disabled?: boolean;
  tone?: 'default' | 'danger';
}

interface RowActionMenuProps {
  items: RowActionMenuItem[];
  ariaLabel?: string;
}

export function RowActionMenu({ items, ariaLabel = '打开操作菜单' }: RowActionMenuProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [menuPosition, setMenuPosition] = useState<{ top: number; left: number }>({ top: 0, left: 0 });

  const visibleItems = useMemo(() => items.filter((item) => Boolean(item)), [items]);
  const estimatedMenuHeight = useMemo(() => visibleItems.length * 40 + 16, [visibleItems.length]);

  const updateMenuPosition = useCallback(() => {
    const anchorRect = containerRef.current?.getBoundingClientRect();
    if (!anchorRect) {
      return;
    }

    const menuWidth = menuRef.current?.offsetWidth || 176;
    const menuHeight = menuRef.current?.offsetHeight || estimatedMenuHeight;
    const spaceBelow = window.innerHeight - anchorRect.bottom;
    const spaceAbove = anchorRect.top;
    const shouldOpenUp = spaceBelow < menuHeight + 12 && spaceAbove > 24;

    const nextTop = shouldOpenUp ? anchorRect.top - menuHeight - 6 : anchorRect.bottom + 6;
    const nextLeft = anchorRect.right - menuWidth;

    setMenuPosition({
      top: Math.max(8, Math.min(nextTop, window.innerHeight - menuHeight - 8)),
      left: Math.max(8, Math.min(nextLeft, window.innerWidth - menuWidth - 8)),
    });
  }, [estimatedMenuHeight]);

  useEffect(() => {
    if (!open) {
      return;
    }

    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      if (containerRef.current?.contains(target) || menuRef.current?.contains(target)) {
        return;
      }
      setOpen(false);
    };

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
      }
    };

    updateMenuPosition();

    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEscape);
    window.addEventListener('resize', updateMenuPosition);
    window.addEventListener('scroll', updateMenuPosition, true);

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
      window.removeEventListener('resize', updateMenuPosition);
      window.removeEventListener('scroll', updateMenuPosition, true);
    };
  }, [open, updateMenuPosition]);

  useEffect(() => {
    if (open) {
      updateMenuPosition();
    }
  }, [open, updateMenuPosition, visibleItems.length]);

  if (visibleItems.length === 0) {
    return null;
  }

  return (
    <div className="inline-flex justify-end" ref={containerRef}>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="text-gray-500 hover:bg-gray-100 hover:text-gray-900"
        aria-label={ariaLabel}
        title={ariaLabel}
        onClick={() => setOpen((current) => !current)}
      >
        <MoreHorizontal className="h-4 w-4" />
      </Button>

      {open
        ? createPortal(
            <div
              ref={menuRef}
              className="fixed z-[120] min-w-44 rounded-xl border border-gray-200 bg-white p-1.5 shadow-xl"
              style={{ top: menuPosition.top, left: menuPosition.left }}
            >
              {visibleItems.map((item) => {
                const Icon = item.icon;
                return (
                  <button
                    key={item.id}
                    type="button"
                    disabled={item.disabled}
                    onClick={() => {
                      setOpen(false);
                      if (!item.disabled) {
                        item.onSelect();
                      }
                    }}
                    className={cn(
                      'flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm transition-colors',
                      item.disabled
                        ? 'cursor-not-allowed text-gray-300'
                        : item.tone === 'danger'
                          ? 'text-red-600 hover:bg-red-50'
                          : 'text-gray-700 hover:bg-gray-100',
                    )}
                  >
                    {Icon ? <Icon className="h-4 w-4" /> : null}
                    <span>{item.label}</span>
                  </button>
                );
              })}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
