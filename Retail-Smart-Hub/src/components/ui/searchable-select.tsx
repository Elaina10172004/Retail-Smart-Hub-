import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, Search, X } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface SearchableSelectOption {
  value: string;
  label: string;
  keywords?: string[];
  description?: string;
  disabled?: boolean;
}

interface SearchableSelectProps {
  value: string;
  options: SearchableSelectOption[];
  placeholder?: string;
  searchPlaceholder?: string;
  emptyText?: string;
  disabled?: boolean;
  clearable?: boolean;
  onChange: (value: string) => void;
  className?: string;
  inputClassName?: string;
}

function normalizeSearchText(value: string) {
  return value.trim().toLowerCase();
}

export function SearchableSelect({
  value,
  options,
  placeholder = '请选择',
  searchPlaceholder = '输入关键字检索',
  emptyText = '没有匹配项',
  disabled = false,
  clearable = true,
  onChange,
  className,
  inputClassName,
}: SearchableSelectProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState('');

  const selectedOption = useMemo(
    () => options.find((option) => option.value === value) || null,
    [options, value],
  );

  useEffect(() => {
    if (!isOpen) {
      setQuery(selectedOption?.label || '');
    }
  }, [isOpen, selectedOption]);

  useEffect(() => {
    const handlePointerDown = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };

    document.addEventListener('mousedown', handlePointerDown);
    return () => document.removeEventListener('mousedown', handlePointerDown);
  }, []);

  const filteredOptions = useMemo(() => {
    const normalizedQuery = normalizeSearchText(query);
    if (!normalizedQuery) {
      return options;
    }

    return options.filter((option) => {
      const haystack = [option.label, option.description || '', ...(option.keywords || [])]
        .join(' ')
        .toLowerCase();
      return haystack.includes(normalizedQuery);
    });
  }, [options, query]);

  const openDropdown = () => {
    if (disabled) {
      return;
    }

    setIsOpen(true);
    setQuery('');
    window.setTimeout(() => {
      inputRef.current?.focus();
    }, 0);
  };

  const closeDropdown = () => {
    setIsOpen(false);
  };

  const handleSelect = (nextValue: string) => {
    onChange(nextValue);
    closeDropdown();
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      closeDropdown();
      return;
    }

    if (event.key === 'Enter') {
      event.preventDefault();
      const nextOption = filteredOptions.find((option) => !option.disabled);
      if (nextOption) {
        handleSelect(nextOption.value);
      }
    }
  };

  return (
    <div ref={containerRef} className={cn('relative', className)}>
      <div
        className={cn(
          'flex h-10 items-center rounded-md border border-gray-300 bg-white px-3 text-sm shadow-sm transition-all focus-within:border-blue-500 focus-within:ring-2 focus-within:ring-blue-500/20',
          disabled && 'cursor-not-allowed bg-gray-50 text-gray-400',
          inputClassName,
        )}
      >
        <Search className="mr-2 h-4 w-4 shrink-0 text-gray-400" />
        <input
          ref={inputRef}
          type="text"
          value={isOpen ? query : selectedOption?.label || ''}
          placeholder={isOpen ? searchPlaceholder : placeholder}
          disabled={disabled}
          className="h-full w-full border-0 bg-transparent p-0 text-sm text-gray-900 outline-none placeholder:text-gray-400"
          onFocus={openDropdown}
          onChange={(event) => {
            setQuery(event.target.value);
            setIsOpen(true);
          }}
          onKeyDown={handleKeyDown}
        />
        {clearable && value ? (
          <button
            type="button"
            aria-label="清除已选项"
            className="mr-1 inline-flex h-6 w-6 items-center justify-center rounded-full text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              onChange('');
              setQuery('');
              setIsOpen(false);
            }}
            disabled={disabled}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        ) : null}
        <button
          type="button"
          aria-label={isOpen ? '收起选项列表' : '展开选项列表'}
          className="inline-flex h-6 w-6 items-center justify-center rounded-full text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            if (isOpen) {
              closeDropdown();
              return;
            }
            openDropdown();
          }}
          disabled={disabled}
        >
          <ChevronDown className={cn('h-4 w-4 transition-transform', isOpen && 'rotate-180')} />
        </button>
      </div>

      {isOpen ? (
        <div className="absolute z-50 mt-2 max-h-64 w-full overflow-hidden rounded-xl border border-gray-200 bg-white shadow-xl">
          <div className="max-h-64 overflow-auto py-1">
            {filteredOptions.length === 0 ? (
              <div className="px-3 py-2.5 text-sm text-gray-500">{emptyText}</div>
            ) : (
              filteredOptions.map((option) => {
                const isSelected = option.value === value;
                return (
                  <button
                    key={option.value}
                    type="button"
                    disabled={option.disabled}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => handleSelect(option.value)}
                    className={cn(
                      'flex w-full flex-col items-start gap-0.5 px-3 py-2.5 text-left text-sm transition-colors',
                      option.disabled
                        ? 'cursor-not-allowed text-gray-300'
                        : isSelected
                          ? 'bg-blue-50 text-blue-700'
                          : 'text-gray-700 hover:bg-gray-50 hover:text-gray-900',
                    )}
                  >
                    <span className="font-medium">{option.label}</span>
                    {option.description ? (
                      <span className="text-xs text-gray-500">{option.description}</span>
                    ) : null}
                  </button>
                );
              })
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
