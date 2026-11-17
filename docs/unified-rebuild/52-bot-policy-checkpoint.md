# 第四十六批實作：bot 共用政策與統一後台

日期：2026-11-17（Asia/Taipei）。分支 `codex/unified-rebuild`。發布範圍 **`none`**：僅隔離實作與驗證，未整合 main、未部署。schema 維持 **14／94 張表**；既有 Python bot、正式憑證、群設定、待送工作及 Compose 不變。

## 已實作

- `packages/contracts/src/bot-policy.ts` 定義完整 17 類通知、三種發送模式、群允許政策、唯一主動通知群、提醒、勿擾、發送間隔及普通／Markdown 模板。`packages/domain/src/bot-policy.ts` 提供明確傳入部署預設的共用驗證、路由、模擬與勿擾計算；活動與投票 producer 使用同一份設定。
- `packages/database/src/bot-policy.ts` 讀取既有 partial document 並補齊預設，保留部署群 fallback、群發現／忽略紀錄及已讀設定版本。發現最多 500 群、忽略紀錄最多 100 筆，管理畫面讀取最近 200 群加上已設定群及最近 20 筆忽略原因；不存訊息內容。
- 勿擾支援跨日、夏令時間跳時及重複時段，與 Python 的本地 wall-clock／fold 行為比對。時區使用既有 canonical allowlist，大小寫精確，避免 macOS 與 Linux 的檔案系統差異；Node Intl 未提供的既有 `Factory` 明確映射為 UTC。發送間隔在 writer transaction 內保留最後嘗試時間，跨連線及重啟保持，延後時不更新最後嘗試。
- 新增 `/api/v2/admin/bot` 讀取、保存、恢復前版及 `/api/v2/admin/bot/preview`。修改要求當前管理權、帳號 scope、origin／CSRF、明確確認、版本與 UUID；相同操作回傳原收據，不因後續版本改變而重做。保存與恢復均追加不可變歷史，業務修改前建立配對保全；semantic no-op 不追加版本。
- 換群作廢群頻道 pending／sending 工作，停用通知類型作廢對應未送工作；只清除 pacing 延後，其他退避保留。提醒變更只重算未來工作，保留已送、模擬、不確定投遞及私人工作。這些行為以真實 Python `bot_settings.save`／恢復前版對照設定、歷史、runtime 與全部提醒列。
- 原生 TSX `/admin/bot` 統一所有設定、17 類預覽、群政策／發現、設定歷史及恢復前版。歷史欄位與狀態使用可辨識名稱；提供目前保存設定供多人編輯時核對，明示 group_openid 與 QQ 群號的區別。沒有新增宣傳、裝飾或重複頁面介紹。
- sessionStorage 原稿按帳號與管理登入 scope 隔離；未知結果保存原 UUID 與完整請求並鎖定修改，重試只查回原操作。包含跨頁／重新載入保護、原稿損壞保全、儲存失敗阻止送出、成功後清理失敗保留原收據及撤權後拒用晚回應。
- 預覽使用共用原生 composer；活動名冊／結算在獨立記憶體資料庫組合，避免合成 ID 恰好命中真實資料。投票組合為純函式。預覽不建立 outbox 或改設定，限制 30 次／分鐘及 512 KiB 請求。

## 隔離驗證

新增 **3 檔／11 項 Vitest**：政策預設／驗證／群路由與 Python 差分、約 224 組跨時區勿擾案例、群狀態差分與有界紀錄、兩連線／重啟 pacing、設定讀取不改資料，以及保存／恢復／提醒完整差分、權限與交易回滾、原收據、17 類預覽與同名真實活動資料隔離。

完整重構回歸 **80 檔／616 項通過**。新增 **6 項瀏覽器測試全部通過**，涵蓋手機設定／模板／換群／恢復前版、斷線後原操作查回、多人編輯保留原稿與核對最新值、儲存失敗／損壞保全／跨頁保護、救援登入／撤權晚回應及成功後本機清理失敗。已檢視 360px 手機實際截圖，無橫向溢出；未把局部測試當成全站 UX 驗收。

既有 Python bot **311 項**、時間投票 bot **15 項通過**。strict TypeScript、重構建置、既有 UI 產物檢查、capability ledger、diff check 與 built smoke 通過。打包後 API smoke 實際驗證 bot 後台 SPA、管理讀取與 no-store、合成預覽以及設定未改；既有 transport、分房 worker、SQLite／sharp、配對備份／匯出與恢復候選啟動封鎖檢查保留。

本批前端約 **1,152.95 kB（gzip 336.99 kB）**，CSS **122.22 kB**；API 約 **694.9 KiB**、分房 worker **95.5 KiB**、bot transport **37.1 KiB**。共用 contracts 初始化增加部分 server bundle，前端大 bundle 與正式規模效能門檻仍未完成。

## 尚未完成

B06／B07／B08／B09／B13 保持 `in_progress`；166 項能力均保留，**0 項完整驗收，`release_eligible=false`**。已讀 revision 只是設定讀取紀錄，不代表 Gateway 連線、心跳或投遞成功。

共用政策與後台尚未構成完整 TypeScript bot：仍缺完整指令／別名／被動回覆、按鈕去重及每次驗群／身份、縮寫與敏感詞、outbox 租約／重試／不確定投遞、通用手動重送、投遞診斷列表與 runtime。群發現與 pacing 函式仍待 runtime／outbox 接入；延後不耗失敗次數必須在實際 consumer 中繼續驗證。

保留既有 Python bot，直至 B01–B15 及跨領域完整驗收。Python 差分與合成平台只能證明已測行為；實際運行的 web／bot 版本組合、正式副本遷移對帳、QQ 與回退驗收尚未完成。本批未啟動第二個投遞者、未提供正式切換入口，也未將模擬送出當成真實投遞。

其餘 public v1／舊網址 adapters、PWA／持久草稿、簡繁語系、完整管理功能與正式規模資源驗收仍按原計畫處理。依使用者要求，暫不部署。
