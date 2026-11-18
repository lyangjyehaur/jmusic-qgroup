# 第八十六批實作：簡繁顯示與原文邊界

日期：2026-11-18（Asia/Taipei）。分支 `codex/unified-rebuild`。變更範圍 **`web`**，實際發布範圍 **`none`**。只使用本機合成資料庫、隔離 Chrome context、mock QQ 及本機 Docker；未合入 main、未部署，未改動正式 bot、憑證、群設定或真實待送工作。

## 語言協商與公開 shell

`displayLanguage` 沿用原 Python 主站規則：取最高 q 值，平手依原 header 順序；只有首選為 zh，帶 Hans／CHS／CN／SG 且沒有 Hant 時顯示簡體。`en-US,zh-CN;q=0.9` 與 `zh-Hant-CN` 仍為繁體。缺失／不合法／零權重項目保守處理，不取次要中文覆蓋首選。

API 的公開 React shell 依 Accept-Language 设置 html lang 與 Content-Language，Vary 為 Accept-Language，Cache-Control 為 no-store。根入口、index、原 HTML alias 與原生路由的 GET／HEAD 共用同一份固定 shell；不建立會員／訪客 session、不設定 cookie。靜態 JS／CSS 仍是同一份不可變資產，API 的 wire values、錯誤與 Cookie cache 邊界保持原樣；此批沒有把任意 API payload 做全文轉換。

Service worker 的離線頁使用相同選擇策略，語言來自 request header 或 browser languages，只有固定恢復提示／活動入口，不含原網址、帳號、活動或其他 cached 私人資料。manifest identity、舊 worker 退役、更新等待、編輯保全與既有 immutable asset cache 行為保持。

## 建置期顯示邊界

新增 Vite 編譯步驟，使用鎖版 OpenCC 在建置期產生簡／繁兩份**已確認的靜態系統片段**；瀏覽器只根據 html lang 選片段，沒有 OpenCC、DOM 全文掃描或 user data converter。來源仍是直接 React／TSX。此批 **82 個前端來源檔、2,868 個顯示邊界**（靜態 JSX、顯示屬性、保守的字面值分支與明確 uiText 宣告）被編譯。

- JSX text 與 title／description／label／placeholder／aria-label／alt 的靜態值可轉換；實際 JS 資料、property access、callback、object key、比較、input value／name、data-*、href 及提交協議值保留。
- JSX 純字面分支、fallback 與串接只轉換其中固定片段；模板、calls、arrays／objects 與動態來源不猜測語意。
- 其他已確認的系統片段可在來源使用 `uiText('固定文字')`；建置拒絕變數或整份 template arguments。插入名稱／理由等內容時先轉固定片段，再串接原內容，不能把使用者值交給 uiText。此批明確補上主要導覽與稱呼修改的 7 個提示片段。
- `translate="no"` 子樹保留；ICP 註冊原號碼不轉換。既有時間欄位的「台北」是兩種字體皆可用的地名寫法，保留以免欄位名稱不必要地漂移。
- 含中文的固定 option label 必須有明確 value；沒有 value 的動態 option 不轉換，避免 HTML 的 implicit submitted value 隨語言改變。
- JSX entity 與多行 whitespace 在建置期解碼／正規化，再以 string 傳給 React；原生渲染對照驗證沒有重複 escape 或空白改變。

原 2026-11-10 隱私內容跟隨顯示語言，不再在 article 固定簡體；版本、生效日期、政策內容與 ICP 原號碼保留。這仍是既有版本政策，尚未補齊統一成分用途與完整新手冊，未藉此變更同意用途或正式發布。

## 隔離驗證

- strict TypeScript、React／API／bot build 與 compiled smoke 通過。最終主 JS **1,405.34 kB／gzip 413.28 kB**，既有大 bundle 警告仍在，未宣稱正式效能通過。worker **4.27 kB**；初版由 contracts umbrella 帶入不必要 schema，改用獨立 `@qgroup/contracts/language` 入口後移除。前端資產沒有 OpenCC／Babel parser runtime。
- **78 項不同原生測試**（11 files）通過：8 個語言／渲染／原文／選項／公開 shell／HEAD／API 原值／離線場景，以及 analytics、runtime、API、auth／profile／registration／activity-registration／auth-bot／activity-bot／bot runtime 回歸。地名保全最後補驗，其餘 backend 契約沒有再改動。
- **62 個不同瀏覽器場景**通過：7 個新語言场景、12 個統計场景、auth／account-profile／activity-sharing／legacy-navigation 及 9 個 PWA 場景。簡／繁保存的混合文字 nickname、原 request body、重新載入及 header 皆保持原文；簡體活動草稿的 `运动` 協議值保留。offline zh-CN 沒有私人資料且可恢復連線，既有 worker activation／retirement／asset cache／QQ 登入／音樂保存與 bot 舊入口不自動寫入均通過。
- Chrome locale 在第一輪覆蓋 extraHTTPHeaders 的 Accept-Language，已查實 actual request 為 en-US；語言 header 場景改在 transport 層明確送入本機 API，offline 場景使用真實 zh-CN browser locale。未把沒送出的 header 記成通過。兩個既有測試對齊隱私頁的繁體標題；台北欄位保全後完整 62 場景重跑通過。
- 360px 無水平溢出、只有一份 header；人工檢視 `test-results/unified-language-mobile.png`。截圖在 resize 後等待兩個 paint frame，消除首次 screenshot 的尾部重影；最後追加此驗證的稱呼場景重跑通過。
- compiled smoke 驗證 API／SQLite／sharp、bounded room worker、bot mock HTTP／WebSocket／ACK／Resume／未知投遞／simulation／CLI／SIGTERM 與配對備份。沒有變更 bot 文字、模板、群政策、schema、outbox 或依賴的網址；新增 contracts subpath 保留原入口，bot bundle 與原契約回歸通過。未證明真實 QQ 平台或線上未更新 bot 的完整候選組合驗收。

## 固定來源與剩餘工作

來源提交 `ff80b111eac7540fb61a5c80a759fc932bf9d8b0`，tree `b17b9830b8718d7936f8afa3627b2b7c8f9a09f4`；prepare-image 在乾淨工作目錄產生 `/tmp/qgroup-image-ff80b111eac7540fb61a5c80a759fc932bf9d8b0/context`，purpose 為 rehearsal。只使用此 archive，未覆蓋未提交程式。

本機 OrbStack arm64 engine 建置／模擬 linux/amd64；完整 image ID **`sha256:afc7096eb7141dd2a8637fa57e78b075dc942d8f66854687509e2ea01e8b4f10`**，Node base 解析為 `node:22.22.3-bookworm-slim@sha256:e21fc383b50d5347dc7a9f1cae45b8f4e2f0d39f7ade28e4eef7d2934522b752`。映像內 strict build／production prune 通過。`verify-image.mjs` 通過原生 API／baked source、React／SQLite／sharp、zero users、UID/GID 994:992、readonly／caps／no-new-privileges／network none、512 MiB／無額外 swap／1 CPU／128 PIDs 與 SIGTERM exit 0。bot 仍只有 version／合成健康檢查，不是 QQ 平台驗收。

Host verifier 另增加容器內的三組 Accept-Language 驗證：zh-CN 選簡體，zh-Hant-CN 及首選 en-US 選繁體；html lang／Content-Language 一致，Vary／no-store／無 Cookie 均通過。此 verifier 的補驗程式不在映像中，映像仍固定於上述來源。自身容器及 volume 已移除；未發布、未推 registry。

O08 改為 `in_progress`；166 IDs 保留，**166 項 in_progress、0 項 planned、0 項完整驗收，release_eligible=false**。這是首批語言實作；尚需逐項標註 object／enum labels、hooks 與其餘顯示訊息，補上 API 產生的通知／安排／結算／錯誤片段與 user interpolation 的可證明邊界、統一新手冊及政策。不得對這些欄位全文轉換或先標記完整簡繁完成。完整 B01–B15、來源資料對帳／遷移／回退、實際候選 web／bot 版本組合、效能及實體裝置／QQ WebView 驗收仍待完成，依使用者要求先不部署。
