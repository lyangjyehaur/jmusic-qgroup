/** Keep the complete record context, but only return to a local participation page. */
export function participationReturn(value: string | null) {
  if (!value || !/^\/(?:activities|me)\/participation(?:\?[^#]*)?$/.test(value)) return null;
  const url = new URL(value, 'https://local.invalid');
  return url.pathname + url.search === value ? value : null;
}
