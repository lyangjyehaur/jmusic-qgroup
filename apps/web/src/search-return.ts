import { SearchQuery } from '@qgroup/contracts';

export function searchParameters(params: URLSearchParams) {
  return Object.fromEntries([...new Set(params.keys())].map(key => [key, params.getAll(key).length === 1 ? params.get(key) : params.getAll(key)]));
}
/** Return only to a validated, same-origin search. Do not accept arbitrary URLs. */
export function searchReturn(value: string | null) {
  if (!value || !/^\/search\?[^#]+$/.test(value)) return null;
  const url = new URL(value, 'https://local.invalid');
  if (url.pathname + url.search !== value || !SearchQuery.safeParse(searchParameters(url.searchParams)).success) return null;
  return value;
}
