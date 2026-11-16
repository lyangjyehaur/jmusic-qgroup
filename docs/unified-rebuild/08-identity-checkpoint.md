# 第二批實作：共用帳號與 QQ 授權

日期：2026-11-17（Asia/Taipei）。分支：`codex/unified-rebuild`。

後續裝置授權／撤權及跨分頁行為已加入[第三批檢查點](09-device-checkpoint.md)；以下保留第二批範圍與當時驗證證據。

發布範圍 **`none`**：只更新隔離的新網站、開發工具、測試及文件。既有 Python／public 運行產物、Docker／Compose、正式 web／bot、憑證與真實待送消息均未操作。最終切換仍按 `both` 評估；本檢查點不能直接部署，也不代表 P1 或全部身分功能已完成。

## 可以執行的流程

- 匿名讀取 session 只建立一天有效的訪客 Cookie／visitor_sessions，不建立會員。活動與音樂共用同一份會員 session。
- `/login` 區分登入及綁定目前帳號。首次授權先明確同意指定版本隱私政策，再前往 QQ；QQ 回調只驗證授權，回到 `/auth/confirm` 後本人再次確認才建立／登入／綁定帳號。
- OAuth state 只存雜湊、十分鐘有效、綁定原裝置、當前帳號、應用、模式及隱私版本；交換授權碼前消耗 pending 狀態。重播、另一裝置、取消、新授權取代、交換期間帳號／session 改變都不會恢復舊授權。
- 身分主鍵是 `provider + client_id + subject`。既有會員綁 QQ 不更換站內 ID、不覆蓋站內稱呼；相同稱呼或 UnionID 都不合併帳號。兩種綁定衝突都明確拒絕。
- UnionID 為可選補充資料；平台未提供時仍可按 OpenID 登入。重授權不覆蓋已有但不同的 UnionID；帳號頁顯示取得狀態與重新授權原 QQ 的入口，不宣稱 bot 個人功能已綁定。
- 確認成功在同一交易寫入身分、同意、裝置授權、session 旋轉與帳號稽核；稽核失敗全部回滾，成功提交後才送 Cookie。舊 Cookie 失效，同裝置其他獨立帳號授權延續。
- `/me/accounts` 列出此裝置已授權的帳號，可明確切換及登出此裝置。切換不搬移活動、款項或成分；已註銷帳號不列出也不能登入／切入。登出撤銷此 session 的所有帳號授權及登入意圖，其他裝置保持登入。
- 登入／取消保留本地活動、投票、邀請 query 與 hash；拒絕外站返回、反斜線、控制字元及編碼的授權循環。活動 → 成分 → 登入 → 保存 → 返回活動已連通。
- 確認登入的回應無法讀取時，停止重複確認／取消，提供完整重新載入的「核對目前帳號」入口，核對後可回原任務。沒有把未知結果顯示成成功。若 Cookie 也未收到，需要重新 QQ 登入既有帳號；目前未實作通用授權結果重放。

私有 API 按帳號 scope 查詢；寫入另驗 Origin／CSRF／明確確認。Cookie 為 HttpOnly、SameSite=Lax；HTTPS origin 加 Secure。未登入、換帳號、撤權與註銷都重新檢查。授權回應不快取，回調採 no-referrer，API 日誌移除 URL query，授權頁／status 不回傳 OpenID、UnionID、access token 或原始 session。

前端只刪除前一個 scope 的私有快取；首次 session 由載入中變成會員時不清除正在讀取的新查詢。這修正了會員進入授權確認／帳號頁時可能一直載入的問題。草稿仍按帳號隔離，登出後清除此分頁的音樂草稿。

## 開發配置與模擬邊界

沿用[開發指令](07-implementation-checkpoint.md#本機開發)。正常空庫不灌會員、示範成分或假登入入口。

新 QQ adapter 只讀 `REBUILD_QQ_APP_ID`、`REBUILD_QQ_APP_KEY`，不自動沿用舊站憑證；兩者未設時顯示尚未配置。固定回調為 `REBUILD_ORIGIN + /auth/qq/callback`。開發 Vite 同時代理 `/api` 與該回調，`/auth/confirm` 由 React 處理。公開 origin 只接受 HTTPS，本機開發可用 localhost／127.0.0.1 HTTP。

Adapter 固定連線 graph.qq.com HTTPS、拒絕重定向、每次請求八秒逾時、回應最多 64 KiB，只保留必要欄位及 qlogo.cn 合法頭像。access token 不入庫；平台回應／錯誤及憑證不回傳給瀏覽器。UnionID 查詢失敗可退回普通 OpenID 查詢。

`apps/api/testsupport/preview.ts` 注入純合成 QQ adapter 及 `/__test/qq` 重定向，供瀏覽器測試完整操作；不連線 QQ，也不投遞消息。正常啟動程式不匯入它，API 建置另檢查依賴圖，不允許 testsupport／測試檔進入運行 bundle。建置煙霧測試強制關閉 QQ 配置，驗證正常空庫與未配置回調。

`/privacy` 是既有 2026-11-10 政策的直接 TSX 鏡像，保留原文、聯絡及 ICP，沒有載入舊 HTML／腳本。這次沒有發布新政策；合併後音樂資料用途、最終入口、簡繁、手冊及新版政策／再次同意仍須在正式切換前完成。舊政策中的既有功能與運維描述不能當成本檢查點已實作的證據。

## 資料與 bot 相容性證據

沒有增加身分表或改變凍結欄位；仍為 59 張相容表、schema marker 及四張音樂表，共 64 張使用者表。補上結構匯出未包含的 `site_settings(id=1)` 安全預設：名稱註冊關閉；重新開庫不覆蓋已有開關或 revision。名稱註冊與管理開關 API 尚未重建，不能宣稱該功能已完成。

`auth-bot.test.ts` 在暫存合成 DB 建立有效名冊、帳本、bot 設定，以及 pending／sending／sent／failed／skipped outbox，再依序執行綁定、登入另一帳號、切回、登出。這些表逐列保持相同，claim token、重試次數、模擬投遞狀態與 payload 都保留。

`tools/rebuild/probe-auth-bot.py` 只以 SQLite `mode=ro` 讀取上述合成庫，呼叫既有 Python `bot_views.shareable/counts/roster_lines`、`accounts.linked` 及 `identity.scope`。綁定前後名冊／人數／scope／outbox 一致，新增 QQ／UnionID 狀態可讀。探測沒有執行舊初始化、連線 QQ 或消費 outbox。

這只證明本批帳號操作的資料保全與指定舊函式讀取相容，**不代表 B01–B15、正式資料遷移、混合版本或實際 bot 全功能已驗收**。全項 bot 門檻持續依 [切換規則](04-migration-and-acceptance.md#bot-全功能上線門檻)執行；不能先上新版網站再補 bot。

## 本機驗證

- `npm run test:rebuild`：30 項領域／API／DB 測試通過，含既有 400 組金額差分、本批帳號安全／交易／失效競態、QQ adapter 失敗情境及上述 Python bot 探測。
- `npm run build:rebuild`：strict TS、React 前端與獨立 API bundle 通過。
- `npm run test:build:rebuild`：編譯產物在隔離空庫啟動，native SQLite、SPA／API、QQ 未配置及回調拒絕通過。
- `npm run test:e2e:rebuild`：12 條本機 Chrome 流程通過；新增登入／同意／確認、取消保留邀請、帳號切換隔離、綁定衝突、隱私頁與回應無法讀取後核對。既有六條成分／公開活動測試仍通過。
- `npm run check:ui`：舊型別及生成產物未漂移。`npm run check:capabilities` 保留 166 項，沒有任何項目冒充完整驗收。
- 檢查桌面及 360／390／768／1280px 授權介面，手機帳號操作可捲動到登出。真實 QQ 平台、QQ WebView、全鍵盤／讀屏、跨分頁撤權與遠端 CI 結果尚未列為通過。

## 尚未完成的身分與後續工作

跨裝置一次性授權、裝置查詢與撤權、帳號歷史介面、名稱註冊及管理開關、修改稱呼、提醒節流與完整跨分頁撤權仍待完成。舊成分找回／認領／ownership、帳號註銷及刪除 ledger 也沒有被這次 QQ 登入取代。

先補齊這些帳號能力，再推進可重跑匯入、既有成分關聯／找回及音樂資料模型。後續仍按原矩陣完成同好、活動／投票／名冊、分房／完整財務、後台與 TS bot、舊入口、遷移／回退，最後成套驗收與正式切換。
