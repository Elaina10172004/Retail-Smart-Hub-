/**
 * Zero-change pagination wrapper for existing list functions.
 *
 * Usage in routes:
 *   paginateList(req, (s) => listSomething(), { searchFields: ['id', 'name'] })
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

export function paginateList<T>(
  req: { query: Record<string, unknown> },
  fetcher: () => T[],
  options?: { searchFields?: string[]; defaultPageSize?: number },
): PaginatedResult<T> {
  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || (options?.defaultPageSize ?? 20)));
  const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';

  let rows = fetcher();

  // Server-side search: filter by keywords across specified fields
  if (search && options?.searchFields?.length) {
    const keywords = search.split(/[\s+]+/).map((k) => k.trim()).filter(Boolean);
    if (keywords.length > 0) {
      rows = rows.filter((row) =>
        keywords.every((kw) =>
          options.searchFields!.some((field) => {
            const value = (row as Record<string, unknown>)[field];
            return typeof value === 'string' && value.toLowerCase().includes(kw.toLowerCase());
          })
        )
      );
    }
  }

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
