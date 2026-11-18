import type { DisplayLanguage } from '@qgroup/contracts/language';
export function offlinePage(language: DisplayLanguage) {
  const title = language === 'zh-Hans' ? '暂时无法连线' : '暫時無法連線';
  const instruction = language === 'zh-Hans' ? '请恢复网络后重新载入。此页不提供离线账号或活动资料。' : '請恢復網路後重新載入。此頁不提供離線帳號或活動資料。';
  const action = language === 'zh-Hans' ? '重新开启活动' : '重新開啟活動';
  return `<!doctype html><html lang="${language}"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} · 群聚</title><main><h1>${title}</h1><p>${instruction}</p><a href="/activities">${action}</a></main></html>`;
}
