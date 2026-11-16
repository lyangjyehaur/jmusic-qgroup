# Yahha UI 元件對應與相容接法

本次範圍：`web`。涵蓋看板、成分站、兩邊管理頁、手冊及政策頁。新增報名者成分的唯讀 API；schema、outbox、bot 入口及既有資料格式保持相容，尚未正式發布。

參照已鎖定的 Yahha UI **v0.2.0** 公開 API、原始碼及設計語言。白紙內容、暖墨操作輪廓、粉色選中與藍灰輕邊線沿用套件；站點 CSS 負責內容排列、密度、響應式及深色語義色，不依賴套件的雜湊類名。

| 畫面元素 | 套件元件 | 使用方式 |
| --- | --- | --- |
| 操作、圖示操作 | Button、IconButton、CloseIcon | 一般 44px；明確標示 small 的次要操作 36px；排行榜為真正按鈕 |
| 輸入、備註 | Input / TextField、Textarea | 保留 name、required、disabled、原生表單驗證及 reset |
| 下拉選項 | Select | 看板以 value / onValueChange 控制，options 直接建立選項；尚未遷移區域才保留原生 select 模型 |
| 勾選、持續開關 | Checkbox、Switch | 高級選項、註冊開關使用 Switch；同意事項仍用 Checkbox |
| 互斥資料選擇 | RadioGroup | 投票、性別、管理預覽模式；只有真正資料欄位參與 FormData |
| 模式、排序、熟悉程度、活動篩選 | SegmentedControl | 已選詞條的熟悉程度直接讀寫選取狀態；其餘未遷移區域操作原控制器的模型按鈕 |
| 成分站主導覽、發現／聚會子頁 | Tabs | 保留路由、返回與資料載入；ARIA 指向實際頁面；鍵盤操作沿用套件 |
| 高級設定、管理工具、手冊章節 | Accordion、Switch | 看板以 hooks 控制 value 陣列及展開狀態，keepMounted 保留輸入；未遷移區域相容 `.open`、toggle |
| 詳情、報名、分房、結算、帳本、管理確認 | Dialog | 每層只有一個可見標題、關閉操作和捲動區域 |
| 錯誤、警示、只讀提示、草稿狀態 | Alert | 看板由 React 狀態呈現；未遷移區域由控制器更新，避免重複包框 |
| 短暫操作回饋 | Toast | 看板使用 open / title / onClose；成分站暫保留控制器計時 |
| 帳號與群友頭像 | Avatar | 看板直接傳入 src / name；成分站未遷移區域保留 img 模型 |
| 收款碼與消費憑證 | Image | 保留原圖連結、下載、載入錯誤重試 |
| 卡片、房間、投票選項、試算與說明 | Surface paper / note | 內容面使用輕紙邊；說明便箋使用 note |
| 狀態與分類 | Badge | 中性分類、強調狀態使用不同 tone |
| 空白、首次載入 | EmptyState、Spinner | 保留原本空狀態操作，無額外裝飾或行銷文案 |
| 標題、段落、連結、分隔線 | Heading、Text、Link、Divider | 正文行高 1.8、標題 1.45；輔助文字通常 14px |
| 全站主題 | ThemeProvider | pink；成分站深色模式保留 |

## 沒有硬套的元件

已檢閱其餘公開元件：Form / FormError 是完整的資料綁定及驗證契約，現有控制器已有伺服器驗證、草稿和原生表單模型，因此表單保持原生 form，錯誤用 Alert。Pagination、DropdownMenu、Popover、Tooltip、Skeleton、Progress 只在真的有分頁、選單、補充內容、預先已知骨架或進度時才需要，本次不為了元件覆蓋率新增互動。

表格、清單、日曆格線、氣泡 SVG、分享 canvas、第三方登入標誌，以及具有業務意義的數據排列保留語義結構。Yahha 沒有這些專用元件；它們的操作、文字和外層內容面使用對應的套件元件。

## 看板與管理後台的直接 React 架構

`ui/board/BoardApp.tsx`、`AdminApp.tsx` 各自建立 React root；表單、彈窗、導覽、待辦與提示由 React 狀態控制。`EventForm`、`Roster`、`Management`、`Money`、`Polls`、`Identity`、`BotSettings` 按業務拆分，直接匯入 Yahha 元件，不載入 HTML parser、MutationObserver 或舊畫面控制器。`primitives.tsx` 統一受控欄位、原生驗證、提交鎖與本機草稿。Yahha Select 自行產生的表單 input 屬於元件本身，不是舊 select 轉接模型。

全部 React 原始碼使用 TSX，純邏輯與共用型別使用 `.ts`；`tsconfig.json` 啟用嚴格模式。`types.ts`／`admin-types.ts` 定義 API 回應、輸入與結算快照；`FormController<T>` 約束表單鍵與值，文字欄位與布林控制不可互用，彈窗名稱與參數也會在編譯期檢查。API 回應型別是編譯期契約，不代表已加入執行期結構驗證。`npm run typecheck` 涵蓋轉接層及編譯期反例測試，並作為建置、UI 測試與產物檢查的前置門檻。

保留非畫面服務的 API、儲存與簡繁訊息功能。純規則位於 `domain.ts`、`rules.ts`、`poll-rules.ts`，用測試和原行為比對；`recovery.ts` 將結果不確定的建立操作重新連回原草稿，防止重複建立。結算、款項與報名仍先呼叫原預覽 API，再以原 token 和版本提交；更改輸入會作廢前次預覽。

`deploy/localize_react.mjs` 在建置時只轉換系統文案；保留分類協議值、物件鍵與 `translate="no"` 內容。API 回傳的名稱、備註和自訂模板按原文顯示。

## 報名者成分串接

`MemberMusic.tsx` 由報名者頭像與名稱旁的 Yahha Popover 呈現，顯示領域、歌手／作品、熟悉程度及與觀看者的共同選擇。浮卡錨定點選位置，不增加活動彈窗或瀏覽紀錄；點外部、關閉按鈕或 Esc 即收起，同時只顯示一人的成分。代報尚未認領的朋友顯示未關聯；觀看者須先登入看板並連結成分站。

新增 `GET /api/events/:event/attendees/:person/music`，先檢查活動存取權、報名歸屬與狀態，再依實際 `attendees.user_id` 查詢現行成分帳號關聯。只傳回選擇資訊，不傳 QQ、OpenID、私密備註或性別。音樂服務內部入口須有專用可信 context；一般 `/music/` 代理無法傳入該權限。查詢不建立或晉升帳號關聯、不修改資料。發布範圍為 `web`：新增模組僅由 web GET 路由載入，無 schema、outbox、bot 入口或既有 API 契約變更。

## 成分站與靜態頁的漸進轉接

首批獨立功能位於 `ui/music/SelectionPanel.tsx`：已選領域與細分、分類、熟悉程度、移除、收合、儲存操作及回到頂部。這些畫面直接使用 TSX 與 Yahha 元件，不經 parser、隱藏模型按鈕或 MutationObserver。`ui/music/selection-store.ts` 是唯一的選取資料來源；React 用 `useSyncExternalStore` 訂閱，原控制器亦經相同行動更新資料。API、匹配與路由暫留原控制器，由命令介面呼叫。儲存回應只確認當次提交的 revision，較新的草稿保持未儲存狀態。回到頂部以 viewport 固定定位，依儲存列實際高度避開儲存列與手機導覽。

以下只適用於尚未遷移的成分站、成分管理與靜態頁。`ui/react-view.tsx` 負責 HTML 與動態節點邊界；`ui/patterns.tsx` 集中維護需相容原生 DOM 的元件。只觀察各自模型的狀態，不掃描或重寫整份文件。

- 原生 dialog 保留 ID、表單、showModal / close、cancel、瀏覽紀錄及草稿參照。彈窗內容持續掛載，開啟時放入 Yahha Dialog；疊層只啟用最上層的套件焦點管理，返回時恢復前一層。
- Accordion 收起保留欄位；建置時只改寫 details / summary 的**元素選擇器**，不改寫名稱包含 summary 的 ID、類名或業務資料。
- 尚未遷移區域的 SegmentedControl 可見選項透過獨立 form 歸屬排除於業務 FormData；模型按鈕與原有監聽保留。
- RadioGroup 的原生 input 是真正資料模型；程式批量修改 checked 與 reset 同步至顯示狀態。
- 收款碼／憑證的原生 img.src 重試會同步 Image 的載入與錯誤狀態。

## 排版與驗證

留白以 4px 為步長，主要欄位間距 20px、橫向欄位 16px、卡片內距 20–24px、區塊間距 24px。不再全域強制所有 button 同一高度，也不對 Badge、Avatar 套用操作高度。手機的四項熟悉程度選擇改為均衡的兩欄；排行榜名稱允許換行；儲存列與底部導覽分開定位。

`npm run test:ui` 包含直接 React 架構與純規則比對、草稿恢復隔離、建置文案轉換、控制器轉換、元件相容契約，以及隔離資料庫的實際瀏覽器流程。涵蓋活動發布、同行、分房、結算、款項、投票、下拉選單、成分修改與儲存、管理編輯、深色模式及窄螢幕。截圖輸出至忽略的 `artifacts/yahha-ui/`；本機預覽只使用測試資料。
