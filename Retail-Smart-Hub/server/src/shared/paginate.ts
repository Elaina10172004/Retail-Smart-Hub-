/**
 * Zero-change pagination wrapper for existing list functions.
 *
 * Usage in routes:
 *   paginateList(req, () => listSomething(), { searchFields: ['id', 'name'] })
 *
 * The original list function is called once (returns all rows), then
 * filtering/pagination is applied in-memory. When datasets grow large,
 * individual list functions should be refactored to use SQL LIMIT/OFFSET.
 */

export interface PaginatedResult<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

type RangeFilterType = 'number' | 'date';

interface RangeFilterOption {
  minKey?: string;
  maxKey?: string;
  field: string;
  type: RangeFilterType;
}

function getQueryText(query: Record<string, unknown>, key?: string) {
  if (!key) {
    return '';
  }
  const rawValue = query[key];
  if (Array.isArray(rawValue)) {
    return String(rawValue[0] ?? '').trim();
  }
  return typeof rawValue === 'string' ? rawValue.trim() : '';
}

function toComparableNumber(value: unknown) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }

  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.replace(/[^\d.-]/g, '');
  if (!normalized) {
    return null;
  }

  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function toComparableDate(value: unknown) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }

  if (typeof value !== 'string') {
    return null;
  }

  const text = value.trim();
  if (!text) {
    return null;
  }

  const matchedDate = text.match(/\d{4}-\d{2}-\d{2}/)?.[0];
  return matchedDate ?? text.slice(0, 10);
}

function normalizeRangeBoundary(value: string, type: RangeFilterType) {
  if (!value) {
    return null;
  }

  return type === 'number' ? toComparableNumber(value) : toComparableDate(value);
}

export function paginateList<T>(
  req: { query: Record<string, unknown> },
  fetcher: () => T[],
  options?: {
    searchFields?: string[];
    defaultPageSize?: number;
    filters?: Array<{ queryKey: string; field: string }>;
    rangeFilters?: RangeFilterOption[];
  },
): PaginatedResult<T> {
  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || (options?.defaultPageSize ?? 20)));
  const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';

  let rows = fetcher();

  // Server-side search: each keyword must match at least one field.
  // By default, ALL string fields on each row are searchable.
  // Provide searchFields to restrict which fields are searched.
  if (search) {
    const keywords = search.split(/[\s\u3000]+/).map((k) => k.trim()).filter(Boolean);
    if (keywords.length > 0) {
      const targetFields = options?.searchFields?.length ? options.searchFields : null;
      rows = rows.filter((row) => {
        const obj = row as Record<string, unknown>;
        const fields = targetFields ?? Object.keys(obj).filter((k) => typeof obj[k] === 'string');
        return keywords.every((kw) =>
          fields.some((field) => {
            const value = obj[field];
            return typeof value === 'string' && value.toLowerCase().includes(kw.toLowerCase());
          })
        );
      });
    }
  }

  options?.filters?.forEach((filter) => {
    const rawValue = getQueryText(req.query, filter.queryKey);
    if (!rawValue) {
      return;
    }

    const acceptedValues = new Set(rawValue.split(',').map((item) => item.trim()).filter(Boolean));
    if (acceptedValues.size === 0) {
      return;
    }

    rows = rows.filter((row) => {
      const value = (row as Record<string, unknown>)[filter.field];
      return value != null && acceptedValues.has(String(value));
    });
  });

  options?.rangeFilters?.forEach((filter) => {
    const min = normalizeRangeBoundary(getQueryText(req.query, filter.minKey), filter.type);
    const max = normalizeRangeBoundary(getQueryText(req.query, filter.maxKey), filter.type);
    if (min == null && max == null) {
      return;
    }

    rows = rows.filter((row) => {
      const rawValue = (row as Record<string, unknown>)[filter.field];
      const value = filter.type === 'number' ? toComparableNumber(rawValue) : toComparableDate(rawValue);
      if (value == null) {
        return false;
      }

      if (min != null && value < min) {
        return false;
      }
      if (max != null && value > max) {
        return false;
      }
      return true;
    });
  });

  const total = rows.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(page, totalPages);
  const offset = (safePage - 1) * pageSize;

  return {
    items: rows.slice(offset, offset + pageSize),
    total,
    page: safePage,
    pageSize,
    totalPages,
  };
}
