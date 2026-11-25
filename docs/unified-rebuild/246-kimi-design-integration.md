# Kimi 原型直接接入

原型：`/Users/danersaka/Projects/jmusic-design/kimi/src`。分支：`codex/unified-rebuild`。工作目錄：`/Users/danersaka/.codex/worktrees/unified-rebuild/qgroup`。

狀態：本機修改，未提交、推送或部署。發布範圍：`web`，包含新增的 web API 讀取能力。未改 schema、共用核心、outbox、報名／候補／結算規則或 bot 網址。正式發布仍須另做與線上 bot 實際版本的組合驗證。

## 接入方式與來源

依使用者回饋，從先前的模仿樣式改成使用原型實際元件與頁面結構：

- `apps/web/src/kimi/prototype.css` 原樣保存原型 `styles.css`；`tools/rebuild/scope-kimi-css.mjs` 只生成作用範圍，產物為 `scoped.css`。`adapter.css` 對應既有外觀變數、深色與舊版樣式衝突。
- `apps/web/src/kimi-ui.tsx` 由原型 `components/UI.tsx` 接入 Yahha 元件；保留原型尺寸、圖示及元件類別，轉接現有回饋與對話框行為。
- `kimi-activities.tsx`、`kimi-music.tsx`、`kimi-music-editor.tsx`、`kimi-me.tsx` 使用相應原型頁面的 JSX 與版面；主導覽、活動詳情、成員列、同好卡片、收件匣與管理入口接入原型結構。
- `docs/unified-rebuild/kimi-source/` 保存全部原型來源快照及 SHA256 清單，供核對來源；其中模擬資料與 AppStore 不加入運行程式。
- API、權限、耐久原稿、冪等鍵、帳號切換保全等由既有控制器負責。分房、帳本、投票及完整管理表單保留現有業務元件，套用共用視覺，沒有以原型的模擬操作取代。

這是以原型元件接資料與操作的整合，並非把整個含模擬資料的原型 App 直接作為正式程式運行。

## 已確認規格

- 粉色預設，保留苔綠／粉／藍／黃；與跟隨系統／淺色／深色及舒適／緊湊分別保存，頁首可直接切換。
- 保留桌布，以及完整管理、舊版資料找回、裝置綁定、隱私刪除流程。
- 活動詳情採總覽／成員／分房／結算／管理；既有其他操作放入相關分頁與更多操作。
- 搜尋、詞條、同好成分卡使用對話框，保留網址、返回來源與瀏覽器歷史。
- **領域獨立，沒有喜好程度；只有細分按本命／常聽／聽過一些／只聽過幾首分組。**
- **活動摘要、名稱／地點搜尋及狀態篩選補上後端讀取功能，保留原型完整工具列。**

## 活動讀取契約

`GET /api/v2/activities` 保留 `page`、`period`，新增可選 `q`、`status`。`GET /api/v2/me/activities` 保留 `page` 並新增 `q`、`status`，不增加 `period`。先對完整有權讀取的集合搜尋／篩選，再分頁；回傳新增 `total`、`summary`、本人 `myRegistration`。

- 公開列表不包含私人、草稿或已刪除活動。
- 摘要近期數量涵蓋全部公開近期活動，不拿當頁筆數充當全站數量；與我有關數量遵循原有參與／管理／款項規則。未登入時私人統計為 null。
- 私人統計與報名狀態只在既有帳號 scope 驗證成功後提供；過期或錯誤 scope 不回傳私人資料。
- 狀態以實際生命週期、歸檔、額滿及報名可用狀態判斷。`paused` 顯示「未開放報名」，涵蓋手動關閉及截止等既有情況，不宣稱都是管理員暫停。
- 我的待辦使用既有收件匣待辦 API；沒有建立第二套待辦規則。
- 舊查詢與既有回傳欄位維持相容；HTTP access review 及生成契約同步更新。

## 原型與既有功能對照

| 原型區域 | 真實功能接法 |
| --- | --- |
| 活動列表／摘要／搜尋／狀態 | 上述新增讀取契約、既有近期／往期／本人可見集合 |
| 活動類型／地點／費用 | 既有類型、集合地點與費用文字；不生成後端沒有的獨立地址或估算金額 |
| 新建與發布 | 原型表單外框、既有時間／時區及草稿→核對→發布流程 |
| 成分工作區 | 領域獨立、細分四級、搜尋加入、耐久保存／核對／復原 |
| 詞庫排行／氣泡 | 真實統計、完整搜尋、領域與細分各自的排名範圍、既有可及性清單 |
| 同好卡片／比較 | 原型卡片承接既有算法、資格、細分喜好、授權留言及聯絡資料 |
| 圈子與找搭子 | 既有真實功能；不顯示原型固定的收藏或互動歷史為真實資料 |
| 分房／投票／結算 | 保留完整既有容量、算法、版本核對、定案、分攤、款項申報與入帳流程 |
| 桌布／管理／找回／隱私 | 保留既有入口、權限與確認步驟，套用共用視覺 |

未對應的模擬欄位不造假；真正改變業務語意時仍逐項詢問使用者。

## 原稿與對話框

音樂、搜尋與同好對話框共用既有音樂選擇控制器。被保留的讀取頁放入不可互動背景；有獨立原稿阻擋器的編輯頁依既有離開核對保全後卸載，返回時恢復原稿。返回值只接受既有契約允許的本機安全路徑；關閉對話框不自動執行業務操作。

## 驗證與限制

驗證使用隔離合成資料，沒有正式資料或真實 QQ 投遞。本輪直接接入的驗證結果如下；前一輪 194 情境屬於舊的樣式實作，未拿來代替本輪驗收。

- `npm run build:rebuild` 通過，包含 HTTP 契約／存取審查、生成資料及 TypeScript；最後手機回饋樣式另以 `npx vite build --config apps/web/vite.config.ts` 重建。
- 相關 API／契約／前端單元測試：13 檔、172 項通過。
- 分批瀏覽器回歸去重後，177 個情境的最新結果通過，涵蓋活動草稿、發布、報名／候補／退出、名冊、分房摘要與歷史、帳本、結算、管理原稿、隱私、桌布、對話框、搜尋、音樂保存／匹配／排行與舊 bot 連結。
- 最後一組 11 項通過，包含 360／390／768／1440px 的幾何、報名後立即返回列表的本人狀態，以及手機鍵盤可視區域、保存列、回到頂部和原稿不丟失。
- 保存結果不再隨手機隱藏的桌面摘要一起消失；還原和核對最新版本操作也保留於手機工作區。
- `npm run test:build:rebuild` 通過，含建置靜態資源、隔離 API／bot 原生運行與讀取、備份／桌布及 worker 檢查。
- 原型 23 個來源快照及原始 CSS 的 SHA256 核對通過；作用範圍生成穩定，運行程式沒有匯入原型 mockData 或 AppStore。
- 淺色／深色、390px／1440px 六個主要頁面共擷取 24 張截圖；所有頁面檢查水平溢出及 JavaScript 錯誤，結果通過，另人工抽查主要畫面與手機保存後提示。截圖在 `/Users/danersaka/.codex/visualizations/2026/11/24/01a20d23-84bd-7923-b7fc-32d9df281360/kimi-direct/`。
- `git diff --check` 通過。

測試紀錄：`/tmp/qgroup-kimi-direct-unit-final.log`、`/tmp/qgroup-kimi-direct-business.log`、`/tmp/qgroup-kimi-direct-retry.log`、`/tmp/qgroup-kimi-direct-e2e-final.log`、`/tmp/qgroup-kimi-direct-music-final.log`、`/tmp/qgroup-kimi-direct-operations.log`、`/tmp/qgroup-kimi-direct-operations-final.log`、`/tmp/qgroup-kimi-direct-final-checks.log`、`/tmp/qgroup-kimi-direct-mobile-final.log`、`/tmp/qgroup-kimi-direct-smoke-final.log`。早期失敗已依後續修正情境補跑通過，沒有跳過業務斷言。

這是本次受影響範圍的驗收，沒有宣稱完整重構專案全部測試或正式 web／bot 混合版本與真實 QQ 驗收。本機 `http://127.0.0.1:5086/activities` 為最新建置的隔離測試資料預覽。

修改前的保全：`/tmp/qgroup-kimi-baseline-20261124-185903/`；本輪開始前另存 `/tmp/qgroup-kimi-direct-baseline-20261124/`。兩者保留既有未提交工作，不含正式資料或 node_modules。
