export function peopleReturn(value: string | null) {
  return value && /^\/people(?:\?[^#]*)?$/.test(value) ? value : null;
}
export function musicPeopleReturn(value: string | null) {
  if (!value || !/^\/people(?:\/circles|\/shouts(?:\/[^/?#]+)?|\/m_[a-f0-9]{24,40}(?:\/compare)?)?(?:\?[^#]*)?$/.test(value)) return null;
  const url = new URL(value, 'https://local.invalid');
  return url.pathname + url.search === value ? value : null;
}
export function musicTrendReturn(value: string | null) {
  if (!value || !/^\/music\/trends(?:\?[^#]*)?$/.test(value)) return null;
  const url = new URL(value, 'https://local.invalid');
  return url.pathname + url.search === value ? value : null;
}
export function musicCircleReturn(value: string | null) {
  if (!value || !/^\/people\/circles(?:\?[^#]*)?$/.test(value)) return null;
  return musicPeopleReturn(value);
}
export function musicShoutReturn(value: string | null) {
  if (!value || !/^\/people\/shouts(?:\/[^/?#]+)?(?:\?[^#]*)?$/.test(value)) return null;
  return musicPeopleReturn(value);
}
