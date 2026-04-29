import { db } from '../database/db';

export interface PaginationParams {
  page: number;
  pageSize: number;
  search: string;
}

export interface PaginatedResult<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export function extractPaginationParams(query: Record<string, unknown>): PaginationParams {
  const page = Math.max(1, Number(query.page) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(query.pageSize) || 20));
  const search = typeof query.search === 'string' ? query.search.trim() : '';
  return { page, pageSize, search };
}

export function parseSearchKeywords(search: string): string[] {
  if (!search) return [];
  return search
    .split(/[\s\u3000]+/)
    .map((k) => k.trim())
    .filter(Boolean);
}

export function buildSearchWhereClause(
  keywords: string[],
  fields: string[],
): { whereClause: string; params: string[] } {
  if (keywords.length === 0 || fields.length === 0) {
    return { whereClause: '', params: [] };
  }

  const params: string[] = [];
  const resolvedClauses = keywords.map(() => {
    const fieldClauses = fields.map((field) => {
      params.push('%');
      return `${field} LIKE ?`;
    });
    return `(${fieldClauses.join(' OR ')})`;
  });

  // After building clauses, replace placeholder % with actual LIKE patterns
  // Actually let's use a cleaner approach
  params.length = 0;
  const cleanClauses = keywords.map((keyword) => {
    const likePattern = `%${keyword}%`;
    const fieldClauses = fields.map((field) => {
      params.push(likePattern);
      return `${field} LIKE ?`;
    });
    return `(${fieldClauses.join(' OR ')})`;
  });

  return {
    whereClause: cleanClauses.join(' AND '),
    params,
  };
}

export function executePaginatedQuery<T>(
  selectClause: string,
  fromJoinClause: string,
  baseWhere: string,
  baseParams: unknown[],
  searchWhere: string,
  searchParams: string[],
  orderClause: string,
  page: number,
  pageSize: number,
): PaginatedResult<T> {
  const allParams = [...baseParams, ...searchParams];
  const whereParts: string[] = [];
  if (baseWhere) whereParts.push(baseWhere);
  if (searchWhere) whereParts.push(searchWhere);
  const fullWhere = whereParts.length > 0 ? `WHERE ${whereParts.join(' AND ')}` : '';

  const countSql = `SELECT COUNT(*) as total FROM ${fromJoinClause} ${fullWhere}`;
  const countRow = db.prepare<{ total: number }>(countSql).get(...allParams);
  const total = countRow?.total ?? 0;

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(page, totalPages);
  const offset = (safePage - 1) * pageSize;

  const dataSql = `SELECT ${selectClause} FROM ${fromJoinClause} ${fullWhere} ${orderClause} LIMIT ? OFFSET ?`;
  const items = db
    .prepare<T>(dataSql)
    .all(...allParams, pageSize, offset);

  return {
    items: items as T[],
    total,
    page: safePage,
    pageSize,
    totalPages,
  };
}
