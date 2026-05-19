import React, { useMemo, useState } from 'react';
import { Filter, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

export interface ColumnFilterOption {
  value: string;
  label: string;
}

export interface RangeFilterValue {
  min: string;
  max: string;
}

export const EMPTY_RANGE_FILTER: RangeFilterValue = { min: '', max: '' };

export function buildColumnFilterOptions(values: Array<string | undefined | null>): ColumnFilterOption[] {
  return Array.from(new Set(values.map((value) => value?.trim()).filter(Boolean) as string[])).map((value) => ({
    value,
    label: value,
  }));
}

export function isRangeFilterActive(value: RangeFilterValue) {
  return Boolean(value.min || value.max);
}

function filterOptions(options: ColumnFilterOption[], keyword: string) {
  const normalizedKeyword = keyword.trim().toLowerCase();
  if (!normalizedKeyword) {
    return options;
  }

  return options.filter((option) => {
    return `${option.label} ${option.value}`.toLowerCase().includes(normalizedKeyword);
  });
}

function ColumnFilterShell({
  label,
  active,
  children,
}: {
  label: string;
  active: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="relative inline-flex items-center gap-1.5">
      <span>{label}</span>
      <Button
        type="button"
        variant={active ? 'default' : 'ghost'}
        size="icon"
        className={cn(
          'h-7 w-7 rounded-full',
          active ? 'bg-blue-600 text-white hover:bg-blue-700' : 'text-gray-500 hover:bg-blue-50 hover:text-blue-600',
        )}
        aria-label={`${label}筛选`}
        onClick={() => setOpen((current) => !current)}
      >
        <Filter className="h-3.5 w-3.5" />
      </Button>
      {open ? (
        <div className="absolute left-0 top-9 z-50 w-72 rounded-xl border border-gray-200 bg-white p-3 text-left shadow-xl">
          <div className="mb-3 flex items-center justify-between gap-2">
            <div className="text-sm font-semibold text-gray-900">{label}筛选</div>
            <Button type="button" variant="ghost" size="icon" className="h-7 w-7" onClick={() => setOpen(false)}>
              <X className="h-4 w-4" />
            </Button>
          </div>
          {children}
        </div>
      ) : null}
    </div>
  );
}

export function MultiSelectColumnFilter({
  label,
  options,
  selectedValues,
  onChange,
  emptyText = '暂无可选项',
}: {
  label: string;
  options: ColumnFilterOption[];
  selectedValues: string[];
  onChange: (values: string[]) => void;
  emptyText?: string;
}) {
  const [keyword, setKeyword] = useState('');
  const selectedSet = useMemo(() => new Set(selectedValues), [selectedValues]);
  const visibleOptions = useMemo(() => filterOptions(options, keyword), [keyword, options]);
  const active = selectedValues.length > 0;

  const toggleValue = (value: string) => {
    if (selectedSet.has(value)) {
      onChange(selectedValues.filter((item) => item !== value));
      return;
    }
    onChange([...selectedValues, value]);
  };

  return (
    <ColumnFilterShell label={label} active={active}>
      <div className="space-y-3">
        <Input
          value={keyword}
          onChange={(event) => setKeyword(event.target.value)}
          placeholder="搜索选项"
          className="h-9"
        />
        <div className="max-h-56 space-y-1 overflow-y-auto pr-1">
          {visibleOptions.length > 0 ? (
            visibleOptions.map((option) => (
              <label
                key={option.value}
                className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm text-gray-700 hover:bg-blue-50"
              >
                <input
                  type="checkbox"
                  className="h-4 w-4 rounded border-gray-300 text-blue-600"
                  checked={selectedSet.has(option.value)}
                  onChange={() => toggleValue(option.value)}
                />
                <span className="truncate">{option.label}</span>
              </label>
            ))
          ) : (
            <div className="rounded-md bg-gray-50 px-3 py-4 text-center text-sm text-gray-500">{emptyText}</div>
          )}
        </div>
        <div className="flex items-center justify-between border-t border-gray-100 pt-2">
          <span className="text-xs text-gray-500">已选 {selectedValues.length} 项</span>
          <Button type="button" variant="ghost" size="sm" className="h-8 px-2" onClick={() => onChange([])} disabled={!active}>
            清空
          </Button>
        </div>
      </div>
    </ColumnFilterShell>
  );
}

export function RangeColumnFilter({
  label,
  value,
  onChange,
  inputType = 'number',
  minPlaceholder = '最小值',
  maxPlaceholder = '最大值',
}: {
  label: string;
  value: RangeFilterValue;
  onChange: (value: RangeFilterValue) => void;
  inputType?: 'number' | 'date';
  minPlaceholder?: string;
  maxPlaceholder?: string;
}) {
  const active = Boolean(value.min || value.max);

  return (
    <ColumnFilterShell label={label} active={active}>
      <div className="space-y-3">
        <Input
          type={inputType}
          value={value.min}
          onChange={(event) => onChange({ ...value, min: event.target.value })}
          placeholder={minPlaceholder}
          className="h-9"
          min={inputType === 'number' ? '0' : undefined}
          step={inputType === 'number' ? '0.01' : undefined}
        />
        <Input
          type={inputType}
          value={value.max}
          onChange={(event) => onChange({ ...value, max: event.target.value })}
          placeholder={maxPlaceholder}
          className="h-9"
          min={inputType === 'number' ? '0' : undefined}
          step={inputType === 'number' ? '0.01' : undefined}
        />
        <div className="flex justify-end border-t border-gray-100 pt-2">
          <Button type="button" variant="ghost" size="sm" className="h-8 px-2" onClick={() => onChange({ min: '', max: '' })} disabled={!active}>
            清空
          </Button>
        </div>
      </div>
    </ColumnFilterShell>
  );
}
