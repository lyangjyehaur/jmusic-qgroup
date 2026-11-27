import { uiText } from './language';

export const isDomainCategory = (value: string) => value === '领域' || value === '領域';
export const categoryLabel = (value: string) =>
  ({ 领域: uiText('領域'), 乐队: uiText('樂隊'), 组合: uiText('組合'), 社团: uiText('社團'), 企划: uiText('企劃') })[value] ?? value;

/** Historical domain records may carry a subcategory; it has no UI meaning. */
export function musicEntryTypeLabel(entry: { kind: string; category: string }) {
  return entry.kind === 'main' ? uiText('領域') : uiText('細分') + ' · ' + categoryLabel(entry.category);
}
