# 第一批實作：單一網站與可重試的音樂保存

日期：2026-11-17（Asia/Taipei）。分支：`codex/unified-rebuild`。

後續已加入[第二批共用帳號實作](08-identity-checkpoint.md)；以下保留第一批範圍與當時證據，最新登入、路由及測試結果見第二批文件。

發布範圍 **`none`**：此批建立隔離開發程式與測試；沒有改動現有 Python／public 運行產物、Compose 或 Dockerfile，未操作正式服務。最終整合切換仍按 **`both`** 評估，不能從本分支直接發布。

## 已完成的前置工作

- 凍結舊版 `legacy/pre-unified-rebuild` 及附註標籤 `pre-unified-rebuild`，兩者指向 `8da877857f163853c449474e168534e2e493121b`。分支、標籤物件與 peeled commit 已核對兩個遠端一致。
- 盤點／設計文件提交 `d4ce58284f47c81dcfbecce88b7f821124ad7fac` 已整合 main，核對 git.dan.tw 與 GitHub main SHA 一致。
- 原 Android QQ 頁首草稿保存在本機 `codex/android-qq-header-draft`，提交 `8232b471078f3a1bee4072cf9bb484e065a48e40`，未併入基線或新版。
- 從文件 main 建立獨立 managed worktree 與 `codex/unified-rebuild`。原 checkout 保留 main。

## 此批可以執行的功能

| 範圍 | 已有實作 | 邊界 |
| --- | --- | --- |
| 單一 React app | 活動、音樂、同好、我的共用 shell、導覽、錯誤與空狀態；直接 TSX＋Yahha | 同好目前明確標示建置中，沒有假推薦 |
| 公開活動 | DB 查詢近期／往期／歸檔、分頁、詳情、分類、時間／人數／說明 | 本人活動、邀請授權、報名／名冊、投票／分房／帳務尚未接入 |
| 生命週期投影 | 預定開始後顯示進行中、已估計超時的提示、真正狀態分開 | 沒有實際開始／結束指令；不偷偷改活動狀態 |
| 音樂詞庫 | 從同一 DB 讀領域／細項、名稱子字串搜尋 | 分類 category、拼音／假名、建立詞條及排行待完成；正常空庫不灌示範詞條 |
| 我的成分 | 同一 session 查自己的成分，選／移除、細項四級、領域保留既有 level 且不展示程度控制、5／15／20 上限、至少一項保存 | QQ 登入與舊成分認領未接入；正常空庫沒有會員，完整登入閉環尚未完成 |
| 草稿與重試 | 按帳號 scope 隔離的 sessionStorage 草稿、刷新恢復、離站提示、先持久化後送出、未知結果沿用 key／內容查回 | 只覆蓋這個新音樂表單；尚未實作舊 IndexedDB、跨頁共用編輯器與其他業務恢復 |
| 保存一致性 | Origin／CSRF／scope、revision、去重、不可變稽核、結果與資料同交易 | 尚未替代其他領域 mutations；不宣稱已完成完整權限系統 |
| 精確金額核心 | BigInt 整數分、千分比例、最大餘數、負項、凍結順序補分 | 純領域函式；尚未連接正式名單、結算及財務帳本 |

從活動詳情進入我的成分會保留返回該活動的路徑。這一批不載入舊頁面或 DOM 控制器；建置會拒絕舊 `ui/`、`music_site/`、`public/` 程式或 `html-react-parser` 進入新前端依賴圖。

介面依 [文案規範](../../AGENTS.md#介面文案與資訊密度) 使用功能頁名，移除口號、裝飾性副標、宣傳卡片與頁尾；原卡片上的成分操作入口保留為直接連結。保存狀態、限額、版本衝突、權限與恢復提示仍保留。此調整只影響隔離開發介面與規範，發布範圍 `none`，不改動既有 API、bot 或正式服務。

## 程式位置

```text
apps/web/src/       React shell、活動、詞庫、帳號、成分編輯器
apps/api/src/       Fastify app、公開投影、音樂儲存與交易
packages/contracts Zod 請求／回應契約與共用型別
packages/domain    精確金額、活動投影、選擇限制
packages/database  SQLite 初始化、凍結結構與新音樂表
tools/migration/   從凍結 Git 提交重建空庫 schema 的工具
tools/rebuild/     開發啟動、API 建置、建置煙霧測試、台帳驗證
```

後端路由目前為 `/api/v2/health`、`session`、`activities`、`activities/:id`、`music/entries`、`me/music`。`me/music` 的 GET 和 PUT 都要求當前帳號 scope；PUT 另驗同源、CSRF 與 idempotency key。私有 API 不快取，錯誤不輸出 SQL 或身份憑證。

`kanban_session`、SHA256 session hash 與既有帳號 scope 演算法保持相容。這不表示已能對線上資料使用：目前只接受明確標記的新開發資料庫，沒有正式匯入器，不能直接把舊庫交給新版。

## 資料安全與未完成的遷移

`tools/migration/export-legacy-schema.py` 只從固定舊 Git 提交取出程式，在暫存資料夾建立合成空庫、兩次初始化後匯出結構。產物是 TypeScript 字串；新運行程式不執行 Python。保留原 59 張看板使用者表、索引、trigger 與 migration 1–20，再新增 schema marker 與四張音樂表，合計 64 張使用者表。

新庫保存 profile、selections 與追加稽核；這是第一條垂直流程的最小模型。尚未處理舊成分的 ownership／覆寫、多份待認領、contact、分類、JSON 未知欄位、趨勢／喊話、刪除 ledger 與媒體，不能稱為完整目標 schema。後續以版本遷移擴充；不以這個最小模型丟棄原資料。

資料庫工廠會拒絕沒有 `rebuild_schema` 標記的非空資料庫，並且在改 journal mode 或增加資料表前拒絕。預設只建立本工作目錄的 `.rebuild-data/unified.sqlite3`。真正遷移需另外實作明確來源、副本、manifest、mapping、刪除優先、可重跑與對帳流程。

## 本機開發

Node 至少 `22.22.3`，npm 至少 `10.9.8`；SQLite native module 需對應 Node／平台，無預編譯時需要本機編譯工具。

```sh
npm ci --no-audit --no-fund
npm run dev:rebuild
```

前端 `http://127.0.0.1:5080`，API `http://127.0.0.1:5081`。Vite 將 `/api` 及 `/auth/qq/callback` 代理到新 API，與原 web／music／bot 隔離。兩個程序由同一開發指令管理。

```sh
npm run check:capabilities
npm run test:rebuild
npm run build:rebuild
npm run test:build:rebuild
npm run test:e2e:rebuild
npm run check:ui
```

瀏覽器測試在記憶體資料庫建立純合成會員／活動／詞條，使用測試專用的合成 QQ adapter／重定向（見第二批文件），沒有真實 QQ 或網路投遞。本機 macOS 若已安裝 Chrome，預設使用它；其他環境先執行 `npx playwright install chromium`。可用 `REBUILD_BROWSER_CHANNEL` 指定已安裝瀏覽器。遠端 CI workflow 已加入，實際遠端結果另行核對。

只看合成公開活動預覽，可在 build 後執行 `node_modules/.bin/tsx apps/api/testsupport/preview.ts`，開啟 `http://127.0.0.1:5082`。這是測試用記憶體庫，結束程序後清除；正常 `dev:rebuild` 不會載入 fixture。

驗證正式建置產物但使用空白開發資料庫：

```sh
REBUILD_ORIGIN=http://127.0.0.1:5081 node .rebuild-dist/api/start.mjs
```

這仍只綁本機 `127.0.0.1`，不作為正式部署指令。`REBUILD_DB` 可指定另一個**隔離開發庫**；勿指定現有資料庫。

## 驗證與完成門檻

- strict TypeScript 檢查、前端建置及後端獨立 bundle 啟動。
- 11 項領域／API／DB 測試，包括 400 組與舊 Python 的金額分攤差分、零元／負項／補分順序、匿名不建帳號、公開權限投影、未知詞條與限額、保存去重、競態版本、切帳號／撤 session／刪除請求拒絕，以及稽核失敗回滾。
- 6 條瀏覽器測試通過，涵蓋公開活動→成分→返回、名稱搜尋、刷新草稿、保存回應丟失、原 key 重試、帳號隔離、未保存離站、儲存失敗不送出、損壞草稿保全、並行更新 409 保稿與明確核對後保存。本機使用既有 Chrome；Playwright Chromium 下載未完成，未把它記為 Chromium 執行證據。
- 360／390／614／768／1280px 無橫向溢出；人工檢視合成桌面與手機截圖。手機保存操作固定在底部；已選清單可直接移除。未驗證真 QQ WebView、深色、簡體、讀屏及完整鍵盤循環。
- 舊 `npm run check:ui` 仍可驗證現有型別與生成產物未漂移；未執行完整舊 Python 業務測試，因為其運行程式未變更。

[驗收台帳](capability-status.json) 保留全部 166 個 ID。此批只將部分標為 `in_progress`，**沒有任何一項完整能力標為通過**，`release_eligible=false`。台帳檢查只能驗證 ID、狀態與證據欄位；不能替代人工驗收或發布來源檢查。

## 接下來的工作順序

現有 bot 的全功能保全從現在的契約與資料設計開始，持續涵蓋後續網站業務、遷移與上線。B01–B15 及跨領域依賴依[上線門檻](04-migration-and-acceptance.md#bot-全功能上線門檻)驗收；P5 是替代 worker 的集中實作階段，不表示前面可以忽略既有 bot。目前未變更正式 bot，也尚未宣稱新版相容性已驗證。

1. 同一帳號的 QQ login／bind／回調確認、隱私同意、多帳號授權與撤權，補完整 P1 身分及錯誤恢復。
2. 在隔離合成來源建立可重跑匯入器，保留固定 ID／ownership、刪除 ledger 與 mapping；補足音樂分類、個人欄位與引用模型。
3. 完成「登入→既有／新成分→同好→活動名單成分」閉環，再依盤點推進全活動、名冊／投票、分房與完整財務。
4. 單一後台、TS bot、公開 v1／舊 URL adapters、備份／回退及 browser／SW 遷移，最後全項驗收。

正式環境仍運行原版。166 項功能、實際資料對帳、相容組合及回退驗收通過後，才將完整重構整合進 main 並另外安排發布。
