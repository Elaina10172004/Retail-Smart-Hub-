import type { ApiEnvelope, PaginatedData } from '@/types/api';

export type MaybePaginated<T> = T[] | PaginatedData<T>;

export function unwrapPaginatedData<T>(data: MaybePaginated<T>): T[] {
  return Array.isArray(data) ? data : data.items;
}

export function unwrapPaginatedEnvelope<T>(response: ApiEnvelope<MaybePaginated<T>>): ApiEnvelope<T[]> {
  return { ...response, data: unwrapPaginatedData(response.data) };
}

/** Build query string for paginated list requests. */
export function pageQuery(params?: { page?: number; pageSize?: number; search?: string }) {
  const qs = new URLSearchParams();
  const p = params?.page;
  const ps = params?.pageSize;
  if (p != null && p > 0) qs.set('page', String(p));
  if (ps != null && ps > 0) qs.set('pageSize', String(ps));
  if (params?.search) qs.set('search', params.search);
  const query = qs.toString();
  return query ? `?${query}` : '';
}

/** Fetch a paginated list, returning the full PaginatedData for use with <Pagination>. */
export async function fetchPaginated<T>(
  path: string,
  params?: { page?: number; pageSize?: number; search?: string },
): Promise<ApiEnvelope<PaginatedData<T>>> {
  const { apiClient } = await import('./client');
  return apiClient.get<ApiEnvelope<PaginatedData<T>>>(`${path}${pageQuery(params)}`);
}
