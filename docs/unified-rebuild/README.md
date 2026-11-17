# 群聚：看板與成分的單一產品重構

日期：2026-11-17（Asia/Taipei）。狀態：完成盤點與 Git 保全，已完成[第一批隔離實作](07-implementation-checkpoint.md)、[共用帳號檢查點](08-identity-checkpoint.md)、[裝置授權檢查點](09-device-checkpoint.md)、[名稱註冊檢查點](10-registration-checkpoint.md)、[稱呼／QQ 檢查點](11-profile-checkpoint.md)、[隱私／刪除恢復檢查點](12-privacy-checkpoint.md)、[管理／審核檢查點](13-admin-checkpoint.md)、[隔離匯入檢查點](14-import-checkpoint.md)、[聯絡／同好入口檢查點](15-contact-checkpoint.md)、[舊成分找回檢查點](16-recovery-checkpoint.md)、[管理成分關聯檢查點](17-ownership-checkpoint.md)、[管理口令／原歷史檢查點](18-pin-history-checkpoint.md)、[獨立成分資料檢查點](19-fields-checkpoint.md)、[活動名單／同好銜接檢查點](20-roster-checkpoint.md)、[活動草稿檢查點](21-activity-drafts-checkpoint.md)、[活動發布與 bot 消費檢查點](22-activity-publication-checkpoint.md)、[已發布安排與逐人確認檢查點](23-activity-conditions-checkpoint.md)、[管理分工與發起者交接檢查點](28-activity-delegation-checkpoint.md)、[現場出席與補錄檢查點](29-activity-attendance-checkpoint.md)、[統一收件匣與活動歷史檢查點](30-inbox-history-checkpoint.md)、[統一收付款帳本檢查點](31-finance-checkpoint.md)、[收款碼與原圖檢查點](32-payment-assets-checkpoint.md)、[逐人結算與包間檢查點](33-settlement-checkpoint.md)、[時間投票檢查點](34-time-polls-checkpoint.md)、[活動包間概況與歷史檢查點](35-room-overview-checkpoint.md)、[音樂詞庫與自建詞條檢查點](36-music-catalog-checkpoint.md)、[共用音樂工作區檢查點](37-music-workspace-checkpoint.md)、[詞條詳情與選取者檢查點](38-music-entry-checkpoint.md)及[音樂排行／統計／氣泡檢查點](39-music-ranking-checkpoint.md)，尚未切換或發布新版。目前發布範圍為 **`none`**。

## 這次要做的事

將「一起聽什麼、認識誰、何時見面、如何分房、最後如何算錢」設計成同一個產品。新系統不沿用兩個網站的頁面邊界、控制器或後端拆分；從共同的使用者、活動與音樂資料開始設計。既有系統提供功能、資料與相容性基線，不限制新架構。

**從零規劃的是產品與程式；現有資料、權限、帳務、歷史、外部入口及功能責任必須延續。** 單一品牌、共用導覽或包上一層 React 都不構成本次「大合併」完成。

盤點與可執行規格已提交；現在按本規格建立全新的 React／TSX 前端、TypeScript 網站後端、共用領域層及工作程序。第一批只打通基礎流程，所有現有功能驗收完成後才切換。TSX 用於畫面；API、資料庫、演算法和 worker 使用 TypeScript，不把伺服器業務寫成 JSX。

## 文件閱讀順序

| 文件 | 回答的問題 |
| --- | --- |
| [現有功能與保留矩陣](01-capability-inventory.md) | 現在能做什麼；新系統放在哪裡；每項如何驗收；依據在哪裡 |
| [統一產品與操作流程](02-product-and-ux.md) | 導覽、頁面、登入、活動、成分與管理如何真正接起來 |
| [技術與資料架構](03-architecture-and-data.md) | React／TSX、TypeScript 後端、資料模型、API、權限與交易如何重建 |
| [遷移、實作順序與驗收](04-migration-and-acceptance.md) | 如何完整保留資料、分批建置、驗證、切換與回退 |
| [程式盤點索引](05-source-audit.md) | 現況來源、有效與停用功能的區分、資料表與 HTTP 入口索引 |
| [機器可讀盤點快照](source-audit.json) | 所查閱程式的雜湊、函式／類別、HTTP 字串線索、DDL 及測試名稱；供後續追蹤變更 |
| [資料表與欄位索引](schema-index.md) | 指定提交在合成空庫建立的 59 張看板表與 10 張成分身分表；不含正式資料 |
| [Git 基線與草稿保全](06-git-baseline.md) | 凍結舊版分支／標籤、未整合草稿與新重構分支的開發方式 |
| [第一批實作與開發方式](07-implementation-checkpoint.md) | 已可執行的範圍、測試證據、啟動方式與下一批工作 |
| [共用帳號實作檢查點](08-identity-checkpoint.md) | QQ 授權、帳號切換、bot 資料保全證據及剩餘身分工作 |
| [裝置授權實作檢查點](09-device-checkpoint.md) | 一次性授權、裝置撤權、帳號紀錄、跨分頁與相容性證據 |
| [名稱註冊實作檢查點](10-registration-checkpoint.md) | 註冊開關、角色與設定競態、限流修正及隔離驗證 |
| [稱呼與 QQ 實作檢查點](11-profile-checkpoint.md) | 稱呼與名冊／bot 差分、外部頭像、UnionID 提醒與恢復 |
| [隱私與持久刪除檢查點](12-privacy-checkpoint.md) | 帳號／成分分別刪除、收據查回、恢復重播、schema 升級與 bot 資料差分 |
| [管理與隱私審核檢查點](13-admin-checkpoint.md) | 救援登入、使用者／角色／私人備註、刪除申請審核與隔離差分 |
| [成套快照匯入檢查點](14-import-checkpoint.md) | 離線輸入契約、原表／bot 工作保全、舊成分權威投影、刪除與重跑保障 |
| [聯絡與同好入口檢查點](15-contact-checkpoint.md) | 聯絡號編輯／清空、會員查詢／複製、草稿／競態、刪除及權威聯絡表 |
| [舊成分找回檢查點](16-recovery-checkpoint.md) | 舊 PIN、持久限流、十分鐘 intent、本次 QQ 授權與原成分保全 |
| [管理成分關聯檢查點](17-ownership-checkpoint.md) | 查詢／預覽／修正／解除、舊操作失效、追加歷史與 bot 資料保全 |
| [管理口令與原關聯歷史檢查點](18-pin-history-checkpoint.md) | PIN 重設、只查回執的斷線恢復、授權撤銷、原紀錄合流與隱私保全 |
| [獨立成分資料檢查點](19-fields-checkpoint.md) | 成分稱呼、性別可見性、私人留言本人編輯、欄位遷移及草稿恢復 |
| [活動名單與同好銜接檢查點](20-roster-checkpoint.md) | 穩定報名者對應、名單／成分浮層、存取權限、活動返回與 Python 差分 |
| [活動草稿檢查點](21-activity-drafts-checkpoint.md) | 原生安排草稿、操作去重、刪除保護、權限與 Python／bot 差分 |
| [活動發布與 bot 消費檢查點](22-activity-publication-checkpoint.md) | 原子發布、自動本人報名、活動卡片／提醒、舊 worker 消費、schema 9 與未知結果恢復 |
| [已發布安排與逐人確認檢查點](23-activity-conditions-checkpoint.md) | 條件版本、逐人決定、有限管理員協助、恢復與 Python／bot 差分 |
| [活動狀態管理檢查點](24-activity-lifecycle-checkpoint.md) | 暫停／恢復、成團、實際開始／結束、取消／歸檔／移除、恢復及 Python worker 相容性 |
| [逐人報名與退出審核檢查點](25-activity-registration-checkpoint.md) | 本人／同行預覽、候補／整組／待確認、逐人修改、退出審核、恢復及 bot 差分 |
| [補報名邀請檢查點](26-activity-invitations-checkpoint.md) | 批量逐人邀請、私人有限預覽、一次性接受、候補確認、恢復及舊 bot 消費 |
| [代報認領檢查點](27-attendee-claims-checkpoint.md) | 七日認領、本人申請／管理審核、原隊位與付款來源、恢復及 Python 差分 |
| [管理分工與發起者交接檢查點](28-activity-delegation-checkpoint.md) | 協辦 scopes、唯一結算人、owner 交接、精確恢復與舊 worker 相容性 |
| [現場出席與補錄檢查點](29-activity-attendance-checkpoint.md) | 出席與費用獨立、現場雙 scope／超額／候補確認、未知結果及 Python 差分 |
| [統一收件匣與活動歷史檢查點](30-inbox-history-checkpoint.md) | 十類待辦／首次已讀、原操作清單／恢復、數字游標、私密快照及 Python 差分 |
| [統一收付款帳本檢查點](31-finance-checkpoint.md) | 十種款項／八種命令、私人申報、逐房核對、追加沖正、結清與舊 worker 消費 |
| [收款碼與原圖檢查點](32-payment-assets-checkpoint.md) | 私人碼庫、凍結碼／憑證原圖、版本分頁、封存保留舊圖與 Python 雙向互讀 |
| [逐人結算與包間檢查點](33-settlement-checkpoint.md) | 五種分攤、逐人付款歸屬、實際包間、原子隨單支出、不可變版本與 bot 凍結通知 |
| [時間投票檢查點](34-time-polls-checkpoint.md) | 跨月日期／精確時段、逐項意願、截止與唯一活動定案、原操作恢復及舊 worker 消費 |
| [活動包間概況與歷史檢查點](35-room-overview-checkpoint.md) | 本人／同行房間、實際凍結姓名、所有預分版本、可見性與唯讀保全 |
| [音樂詞庫與自建詞條檢查點](36-music-catalog-checkpoint.md) | 分類／別名、原建立清單限額、會員建立／改名／刪除、未知結果與成分刪除保全 |
| [共用音樂搜尋與成分工作區檢查點](37-music-workspace-checkpoint.md) | 拼音／首字母／假名差分、同一草稿／選擇／保存狀態、分類收合、跨頁恢復及帳號隔離 |
| [詞條詳情與選取者檢查點](38-music-entry-checkpoint.md) | 原生獨立詳情、成員可見名單、複製／成分卡返回、保存後刷新與快取權限 |
| [音樂排行／統計／氣泡檢查點](39-music-ranking-checkpoint.md) | 獨立排行展開、完整詞庫／搜尋、原建立時間與 schema 10、鍵盤氣泡與草稿／統計更新 |
| [166 項驗收台帳](capability-status.json) | 每項實作狀態與剩餘工作；未完整驗收不標記通過 |

## 現況結論

1. 看板主畫面與管理頁已有直接 TSX；成分站只有選取區與工具列是直接 TSX，其他畫面和管理頁仍以舊 JavaScript／DOM 控制器轉接。兩者不是同一種完成度。
2. 看板 SQLite、成分 JSON、成分身分 SQLite、兩套刪除紀錄與圖片／壁紙各有生命週期。HTTP 入口共用不等於交易、身分和備份已合併。
3. 同一個人可能只有看板帳號、只有舊成分、兩邊未關聯、已關聯，或保留多份待核對成分。QQ 號、自填聯絡 QQ、OpenID、UnionID、人工備註與站內 ID 不能混為一談。
4. 活動正式名冊／包間與音樂匹配試算是兩套流程。新設計把建議、人工調整、正式採用與實際結算接在同一場活動中，各步仍有明確權限與確認。
5. 財務、認領、候補、版本、未知結果重試及 bot 投遞是既有核心能力。重寫時必須保留語意，不能只比頁面數量。
6. 舊文件有時間差。權限、匹配公式與可用入口以程式和對應測試交叉核對；矛盾列入 [盤點索引](05-source-audit.md)，不無聲選用舊說明。

## 已採用的設計決策

- 工作名「群聚」，頂層四個入口為 **活動、音樂、同好、我的**。通知與待辦使用全站同一收件匣；管理員進入同一管理後台。不存在「返回看板／進入成分站」這種產品切換。
- 音樂編輯在「我的成分」，詞條發現在「音樂」；兩處共用同一份編輯草稿與保存狀態。排行、氣泡、趨勢、分享及找搭子完整保留，各有明確位置。
- 活動詳情承載安排、報名、同好成分、分房與結算。自由分房試算仍可獨立使用；採用至活動是新增的明確動作，不自動改名單、不自動記帳。
- 一套 React app、一套網站 API、一個權威業務資料庫、一套會員 session、一套角色判斷。業務按領域模組化；bot 為同專案的獨立 worker，可獨立部署。
- 前端使用 React＋TSX strict；網站後端使用 TypeScript＋Fastify；SQLite 與檔案資產延續小站的部署規模。重建業務層並用舊系統作差分測試，不保留 DOM 轉接層作最終實作。
- 既有 Python bot 在過渡期以固定版本相容運作；最終由 TypeScript worker 接手所有既有 bot 能力，驗收完成才退役 Python worker。重構不以新增群內直接報名或支付功能作為範圍。
- 新介面一次切成單一產品；開發可分階段，每階段都有功能與資料證據。不能以「先合首頁，其他日後再做」宣告合併完成。

## 「完成」的最低定義

- [功能矩陣](01-capability-inventory.md)每個 ID 都有新入口、後端實作、資料驗證和驗收證據，沒有以「低頻」或「舊站功能」為由刪項。
- 新前端含管理、登入確認、說明與隱私頁全部為直接 TSX；前後端共用已驗證的契約。正式 bundle 不載入舊控制器、HTML parser、隱藏 DOM、雙份元件狀態或舊網站 iframe。
- 已關聯會員只需一次登入；從活動看成分、從成分認識同好、回到活動報名與分房不丟失上下文。沒有成分的會員仍能完整使用活動。
- 原名冊順序、帳務金額、所有歷史版本、付款責任、個人可見性、刪除意圖與未完成操作有完整去向。
- 舊活動／投票／邀請／QQ 回調／bot 連結、合作方 API v1 及已安裝 Service Worker 經過相容驗收。
- 遷移與回退已在隔離副本演練；正式來源、版本組合、資產和新寫入保全符合[發布政策](../deployment-policy.md)。

## 盤點邊界

程式基線是 `origin/main` 的 `8da877857f163853c449474e168534e2e493121b`；已抓取核對。文件分支為 `codex/unified-product-plan`。工作目錄原有 Android QQ 頁首／靜態產物等未提交修改，另行保留，未將它們當作已發布能力，也未改動它們。

盤點包含本機程式、既有測試、使用說明與發布紀錄；沒有讀取正式會員資料或憑證、沒有操作正式服務。歷史發布文件中的會員數、映像與 OAuth 結果只代表其記錄時間，不能據此宣稱目前線上狀態或本輪已完成真實 QQ 驗收。功能矩陣是待驗收規格，不是本輪測試通過報告。
