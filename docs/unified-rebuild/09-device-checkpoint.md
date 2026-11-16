# 第三批實作：裝置授權、撤銷與帳號紀錄

日期：2026-11-17（Asia/Taipei）。分支：`codex/unified-rebuild`。發布範圍 **`none`**。

本批在隔離重構程式補上 I08／I09 及部分 I07／I16。未操作正式 web、bot、憑證、群設定或待送工作，未更改舊 Python／public 運行產物或 Docker／Compose。正式切換仍按 `both` 驗證；本批不代表 P1、166 項能力或完整 bot 驗收已完成。

## 操作與實作

帳號頁進入 `/me/devices`，可管理目前帳號授權的裝置、產生自己的另一台裝置使用的限時連結、撤銷未用連結及讀取帳號紀錄。

- 產生連結前確認只授權自己的裝置。連結十分鐘有效、一次使用；產生新連結撤銷此帳號之前的未使用連結。成功回應才展示供手動／剪貼簿複製的網址，明確提示持有者可管理帳號與帳務。
- 接受入口為 `/me/devices/accept#token=…`。token 放網址片段，不送入 HTTP URL／Referer；API 只在 POST body 接收，不放 query、路徑、query cache key 或稽核內容。頁面成功存到本分頁 sessionStorage 後移除網址片段，刷新及登入返回可恢復。新的片段連結會重新讀取，不沿用上一個連結狀態。
- 接受頁先顯示授權帳號、期限及現有帳號，不會因讀取而消耗。訪客先登入此裝置原有帳號再返回；本人再次勾選並確認接受後，才增加裝置授權。原帳號、活動、款項與成分分開保留，接受後不自動切換。
- 已授權同一帳號的裝置直接引導切換，不再次消耗連結。取消只離開並清除此分頁連結，不新增或消耗授權。登入／授權帳號已註銷則拒絕。
- 接受結果無法讀取時停止重複送出；用 token 加接受時的原 session 核對 used_by 與仍有效的 grant，才能讀到接受結果。其他 session 不能查看這個回執。連結過期後到帳號頁核對現有授權；沒有通用結果重放。
- 裝置列表只列目前帳號的授權時間及既有不透明 ID，不猜測瀏覽器名稱、位置或最近活動。撤其他裝置有第二次確認；目前裝置只能從帳號頁登出。
- 撤銷只移除此帳號在目標裝置上的 grant。目標若正在使用別的帳號，該帳號及其登入意圖保留；若正在使用被撤銷帳號，轉回該裝置另一個有效帳號並作廢原登入意圖。沒有有效替代帳號就刪除 session，已註銷 grant 不作替代。原 scope 的私有讀寫會被拒絕。
- 帳號紀錄按 ID 倒序每頁 25 筆，可繼續讀取較早紀錄；只回傳動作、時間與分頁 ID，不公開 details_json、token、QQ 識別或其他帳號資料。

新增 API：`GET me/devices`、`GET me/account-history?before=…`、`POST me/devices/link`、`POST me/devices/revoke-link`、`POST me/devices/revoke`、`POST device-links/view`、`POST device-links/accept`，皆在 `/api/v2/` 下。私有 GET 要求當前 member scope；POST 另檢查 Origin、CSRF、格式及確認項目。view 可由有效訪客 session 讀取，真正接受須先登入。產生、讀取及接受各有路由限流。

## 資料與恢復界線

未新增或改動資料表／欄位，仍有 64 張使用者表；使用原 `device_links`、`browser_accounts`、`browser_sessions`、`login_attempts`、`auth_requests` 與追加式 `account_audit`。新增連結在 token 欄儲存 `sha256:` 加 digest；未過期舊明文 token 可由新 API 接受，不改寫舊值。原 Python 不會解析新 digest 連結，因此不能把這當作新舊 web 可任意混用的證據；最終切換仍須完成舊入口轉接、遷移與實際版本組合驗收。

發行／取代連結、接受授權、撤權／切回替代帳號與稽核都在同步 SQLite immediate 交易內。任一步驟失敗整筆回滾；競爭接受只有一個成功。撤裝置及撤未用連結不改業務資料、bot 設定或 outbox。

連結只暫存於本分頁；取消或此裝置登出會清理。瀏覽器儲存不可用時保留原 fragment，停止送出並提示恢復。剪貼簿失敗可手動選取文字。產生／撤銷回應不明時要求核對或先撤未用連結，沒有把結果直接記成成功，也未實作所有身分 mutation 的持久去重。

## 跨分頁與其他裝置

同一瀏覽器透過 BroadcastChannel 只傳送 refresh／logout 通知，不傳身份、token 或草稿。其他分頁重新向伺服器確認 session，再移除舊 scope 私有快取。帳號切換後原帳號的分頁草稿保留，切回可恢復；登出清除收到通知分頁的音樂草稿及暫存裝置連結，私人畫面回到訪客狀態。

BroadcastChannel 不可用或建立失敗不會阻斷已提交的登入／登出；session 在頁面回到前景、網路恢復及前景每 30 秒重新讀取。其他實體裝置沒有即時推播撤權；UI 依上述讀取更新，伺服器則立即拒絕原 scope 操作。離線、背景分頁、瀏覽器完全禁止儲存、跨程序時序與全面敏感資料清理仍須完整驗收，不宣稱所有情況即時生效。

## 本機證據

- `npm run test:rebuild`：42 項領域／API／DB 測試通過。新增 12 項覆蓋十分鐘邊界、確認與權限、雜湊儲存、舊 token、過期／替換／撤銷、並行接受、receipt 隔離、本人／其他帳號撤權、註銷替代排除、稽核失敗回滾及歷史分頁／資料最小化。
- `npm run build:rebuild`、`npm run test:build:rebuild`：strict TS、React 與獨立 API 建置、隔離空庫 smoke 通過；測試 adapter 不進正常 API bundle。
- `npm run test:e2e:rebuild`：18 條本機 Chrome 測試通過。新增六條涵蓋兩個獨立 browser context 的授權／切換／撤權與原成分保留，訪客登入返回、取消與替換連結、結果無法讀取後核對、儲存失敗不送出、跨分頁登出清稿及切換後原稿恢復。
- 檢視合成桌面撤權與 360px 接受頁截圖，沒有橫向溢出；保留權限提示、明確確認與恢復入口。真 QQ WebView、讀屏、完整鍵盤／語言、全裝置組合待驗收。
- 既有 `auth-bot.test.ts` 新增接受裝置 grant、切換、撤權再切回流程，原活動、名冊、帳本、bot 設定及所有 outbox 投遞狀態逐列相同；舊 Python 只讀函式仍能取得同樣人數／名冊／帳號 scope 與 QQ 狀態。未消費或投遞任何真實消息。
- `npm run check:ui` 舊型別與生成產物未漂移；`npm run check:capabilities` 仍保留 166 項，0 項完整驗收、`release_eligible=false`。

## 後續

名稱註冊與管理開關、修改站內稱呼、UnionID 提醒節流、帳號註銷／刪除 ledger、舊入口及完整錯誤恢復仍待補。之後推進可重跑資料匯入、舊成分關聯／找回／認領，再完成同好、活動／名冊／投票、分房、財務、後台、TS bot 及遷移／回退驗收。

現有 bot 全功能仍是切換硬門檻。本批只增加裝置身分流程的合成資料保全證據，不把它當成 B01–B15 或線上混合版本驗收。
