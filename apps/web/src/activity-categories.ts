import { uiText } from './language';

/** Labels for the fixed activity protocol; unknown imported values remain original. */
export const activityCategories = [
  ['约K', uiText('約 K')], ['聚餐', uiText('聚餐')], ['运动', uiText('運動')],
  ['出游', uiText('出遊')], ['游戏', uiText('遊戲')], ['其他', uiText('其他')],
] as const;
const labels = new Map<string, string>(activityCategories);
export function activityCategoryLabel(value: string) { return labels.get(value) ?? value; }
