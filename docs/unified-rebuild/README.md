# 群聚：看板與成分的單一產品重構

日期：2026-11-20（Asia/Taipei）。狀態：完成盤點與 Git 保全，隔離實作持續進行，最新進度見[原帳號關閉、完整業務重建與來源重整檢查點](130-account-business-source-rebase-checkpoint.md)。完整功能、資料遷移與 bot 候選版本組合尚未驗收；未切換或發布新版，目前發布範圍為 **`none`**。

後續已完成[統一 PWA](62-pwa-checkpoint.md)、[bot 並行寫入修正](63-bot-sqlite-locking-checkpoint.md)、[共用表單 IndexedDB 原稿](64-durable-drafts-checkpoint.md)、[活動與帳務原稿持久化](65-durable-authoring-checkpoint.md)、[活動參與原稿持久化](66-durable-participation-checkpoint.md)、[邀請與分工原稿持久化](67-durable-invitations-checkpoint.md)、[帳號與成分原稿持久化](68-durable-identity-checkpoint.md)、[管理原稿與權限失效保全](69-durable-admin-checkpoint.md)、[管理內容原稿持久化](70-durable-admin-content-checkpoint.md)、[成分關聯與 PIN 回執持久化](71-durable-admin-ownership-checkpoint.md)、[成分刪除後原操作核對](72-erased-music-acknowledgements-checkpoint.md)、[bot 設定原稿持久化](73-durable-bot-policy-checkpoint.md)、[收件匣管理回執隔離](74-admin-operation-receipts-checkpoint.md)、[通知已讀操作持久化](75-durable-notifications-checkpoint.md)、[群通知原重送操作持久化](76-durable-bot-deliveries-checkpoint.md)、[活動查看邀請操作持久化](77-durable-activity-access-checkpoint.md)、[找搭子原稿與發布操作持久化](78-durable-music-shouts-checkpoint.md)、[舊成分找回操作持久化](79-durable-music-recovery-checkpoint.md)及[自由／活動分房原稿持久化](80-durable-music-rooms-checkpoint.md)的隔離實作；另已完成[隱私刪除回執保全](81-durable-erasure-recovery-checkpoint.md)、[短效裝置連結](82-short-lived-device-links-checkpoint.md)、[舊本機紀錄保全](83-legacy-local-preservation-checkpoint.md)、[持久建立識別](84-create-intents-checkpoint.md)、[舊活動／投票草稿轉換](85-legacy-authoring-conversion-checkpoint.md)與[舊包間／收支原稿轉換](86-legacy-money-conversion-checkpoint.md)；全站遷移與正式切換驗收仍未完成。

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
| [同好推薦／成分比較檢查點](40-music-matching-checkpoint.md) | 兩種排序、資料較少分區、指定比較、留言條件可見、共用選詞往返與 Python 差分 |
| [成分分享檢查點](41-music-sharing-checkpoint.md) | 草稿／清單複製、原生 Canvas PNG、配色／下載／裝置分享、匯出白名單與排序偏好 |
| [音樂趨勢檢查點](42-music-trend-checkpoint.md) | 定時持久取樣、原生圖表／漲幅、最近新增、同一草稿及私人成員名單 |
| [同好圈子檢查點](43-music-circles-checkpoint.md) | 原生完整圈子／門檻、間接連結／穩定順序、獨立成員、同好／比較／詞條往返與 bot 唯讀差分 |
| [找搭子與管理移除檢查點](44-music-shouts-checkpoint.md) | 原生發布／歷史／聯絡、未知結果恢復、schema 11、成分刪除及 bot 資料保全 |
| [管理詞庫 CRUD 與合併檢查點](45-admin-music-catalog-checkpoint.md) | 原生 CRUD／合併、建立紀錄與編輯權分離、schema 12、未知結果及 bot 資料保全 |
| [管理成分刪除與重置檢查點](46-admin-music-erasure-checkpoint.md) | 原生管理刪除／重置、持久意圖與精確恢復、舊快照防復活及 bot 資料保全 |
| [全站外觀與壁紙檢查點](47-appearance-checkpoint.md) | 深淺／系統主題、個人開關、原生壁紙管理、schema 13 原圖交易與 bot 資料保全 |
| [配對備份與成分匯出檢查點](48-backup-export-checkpoint.md) | 同一 writer lock 下配對 SQLite／圖片／ledger、管理寫入前保全、歷史下載的最新刪除與身份投影 |
| [隔離恢復候選檢查點](49-offline-restore-checkpoint.md) | schema 14 來源識別、最新刪除與 bot 投遞對帳、群授權保全、私有候選與啟動封鎖 |
| [自由／活動分房檢查點](50-music-rooms-checkpoint.md) | 舊演算法差分、有界 worker、來源失效與草稿保全、人工調整、分享及正式採用 |
| [TypeScript bot 連線與診斷檢查點](51-bot-transport-checkpoint.md) | 原生 token／OpenAPI／Gateway／Resume、私有診斷、本機平台測試與完整 worker 剩餘工作 |
| [bot 共用政策與統一後台檢查點](52-bot-policy-checkpoint.md) | 完整設定／模板預覽／版本恢復、群政策、勿擾與間隔差分、原稿與收據保全及 worker 剩餘工作 |
| [TypeScript outbox consumer 檢查點](53-bot-outbox-checkpoint.md) | 原生 claim／重試／pacing、凍結與當前內容、逐碼投遞、取消／不確定保全及新舊 worker 差分 |
| [TypeScript bot 公開指令與回覆檢查點](54-bot-public-replies-checkpoint.md) | 全部指令別名、25 種公開回覆、相同交易快照、唯讀保全、Python 差分與 runtime 剩餘工作 |
| [TypeScript bot 縮寫與完整續讀檢查點](55-bot-abbreviations-checkpoint.md) | 引用擷取、完整遮罩／快取、QQ 分段／續讀、游標保全、新舊檔案互讀及 runtime 剩餘工作 |
| [TypeScript bot 事件與 worker 隔離檢查點](56-bot-dispatch-checkpoint.md) | 訊息／按鈕 ACK、去重、群政策、CPU／SQLite 隔離、token 後再驗與本機平台驗證 |
| [原生 bot runtime 與投遞所有權檢查點](57-bot-runtime-checkpoint.md) | Gateway／outbox／面板／health 統籌、Python／TS 同目錄互斥、停止與未知投遞保全及建置後 CLI |
| [統一群通知與明確重送檢查點](58-bot-deliveries-checkpoint.md) | 群通知篩選／核對、依業務權限重送、原工作保全、精確回執恢復與新舊 consumer 相容性 |
| [bot 跨應用身分診斷檢查點](59-bot-identity-diagnostics-checkpoint.md) | UnionID 是否存在／站內布林匹配、唯讀隔離、診斷容量限制與原始識別值保密 |
| [合作方 API v1 檢查點](60-partner-api-checkpoint.md) | 原路徑／鑑權／錯誤契約、逐欄 Python 差分、唯讀快照、名冊／包間白名單與 bot 資料保全 |
| [舊入口與活動邀請檢查點](61-legacy-navigation-checkpoint.md) | bot actions／成分 hash、明確可見授權、私人分享、再約草稿與本人活動 |
| [統一 PWA 與舊離線元件退役檢查點](62-pwa-checkpoint.md) | 安裝身分、明確更新、多視窗快取保全、離線資料隔離及舊 worker 自然退役 |
| [bot 並行寫入交易檢查點](63-bot-sqlite-locking-checkpoint.md) | WAL writer 競爭、群觀察保全、政策版本刷新及修正前後回歸 |
| [共用表單 IndexedDB 原稿檢查點](64-durable-drafts-checkpoint.md) | 關頁／重啟恢復、圖片、分頁衝突保全、原操作持久化、清除世代及失敗重試 |
| [活動與帳務原稿持久化檢查點](65-durable-authoring-checkpoint.md) | 活動／再約／安排、帳務與收款碼原圖、原子轉移、跨頁編輯保全與收件匣查回 |
| [活動參與原稿持久化檢查點](66-durable-participation-checkpoint.md) | 報名／逐人管理、安排回覆、狀態與出席、重新確認、原操作查回及連結預選保全 |
| [邀請與分工原稿持久化檢查點](67-durable-invitations-checkpoint.md) | 邀請／認領／管理分工、能力連結範圍、原操作查回與身分重新核對 |
| [帳號與成分原稿持久化檢查點](68-durable-identity-checkpoint.md) | 帳號稱呼、成分選擇／資料／聯絡、工作區導覽、原操作與固定身分保全 |
| [管理原稿與權限失效保全檢查點](69-durable-admin-checkpoint.md) | 使用者備註／角色、刪除審核、管理清除世代、救援登出重試與權限範圍保全 |
| [管理內容原稿持久化檢查點](70-durable-admin-content-checkpoint.md) | 詞庫／壁紙／找搭子管理、原圖保全、關頁查回、原操作與分頁版本 |
| [成分關聯與 PIN 回執持久化檢查點](71-durable-admin-ownership-checkpoint.md) | 關聯原稿／解除、PIN 僅留操作編號、異常紀錄下載、同頁離開與撤權保護 |
| [成分刪除後原操作核對檢查點](72-erased-music-acknowledgements-checkpoint.md) | 成分已不存在時的原關聯／PIN 回執、拒絕後保稿、交易失敗與操作編號保全 |
| [bot 設定原稿持久化檢查點](73-durable-bot-policy-checkpoint.md) | 模板／群政策／設定、保存與恢復前版原命令、收件匣查回、分頁保全與撤權保護 |
| [收件匣管理回執隔離檢查點](74-admin-operation-receipts-checkpoint.md) | 管理與會員回執分流、原管理授權範圍、只讀查核與安全返回原表單 |
| [通知已讀操作持久化檢查點](75-durable-notifications-checkpoint.md) | 單筆／批量已讀、關頁恢復、交易確認、雙分頁競爭、損壞保全與登出隔離 |
| [群通知原重送操作持久化檢查點](76-durable-bot-deliveries-checkpoint.md) | 活動／投票原命令、關頁回執、政策變更、交易確認、權限與分頁衝突 |
| [活動查看邀請操作持久化檢查點](77-durable-activity-access-checkpoint.md) | 原邀請／UUID／revision、關頁查回、限流保留、分頁保全與帳號隔離 |
| [找搭子原稿與發布操作持久化檢查點](78-durable-music-shouts-checkpoint.md) | 原文字／UUID／成分身份、關頁恢復、交易確認、分頁衝突與刪除隔離 |
| [舊成分找回操作持久化檢查點](79-durable-music-recovery-checkpoint.md) | 原 UUID／QQ／action、PIN 隔離、精確查詢、關頁核對、交易／分頁保全與秘密原文下載 |
| [自由／活動分房原稿持久化檢查點](80-durable-music-rooms-checkpoint.md) | 名單／設定／人工安排／結果、來源快照、交易確認、分頁競爭與無訊號清除隔離 |
| [隱私／管理刪除回執持久化檢查點](81-durable-erasure-recovery-checkpoint.md) | 獨立憑證庫、原回執／精確重送、關頁／分頁競爭、清除恢復與秘密匯出隔離 |
| [短效裝置連結與恢復檢查點](82-short-lived-device-links-checkpoint.md) | 原連結／十分鐘期限、雙端確認、交易／分頁竞争、登出世代與關頁恢復 |
| [舊看板本機紀錄保全檢查點](83-legacy-local-preservation-checkpoint.md) | 原 scope／草稿／图片／請求、來源保留、Python 原回執查詢、競爭保全與重複操作阻擋 |
| [活動／投票建立識別檢查點](84-create-intents-checkpoint.md) | 原建立別名、跨請求去重、原回執不改寫、目前舊 React 草稿辨識與後續編輯保留 |
| [舊活動／投票草稿轉換檢查點](85-legacy-authoring-conversion-checkpoint.md) | 原欄位／時區／版本與意圖、目的 strict commit、來源映射、延遲請求與競爭保全 |
| [舊包間／收支原稿轉換檢查點](86-legacy-money-conversion-checkpoint.md) | 原房間／款項 ID、停用欄位保全、原款項唯讀查詢、目的 CAS／pending 與時間核對 |
| [舊結算原稿轉換與封存檢查點](87-legacy-settlement-conversion-checkpoint.md) | 未選人員／休眠模式、原圖／歷史引用、原裝置時間、目的 CAS 與送出前交易封存 |
| [舊財務請求恢復檢查點](88-legacy-finance-request-checkpoint.md) | 原隨機 key／本機指紋、Python 簽名／預覽、原子回執、明確重試與 durable 核對 |
| [統一映像與啟動檢查點](89-unified-runtime-checkpoint.md) | 乾淨來源 archive、原生 amd64 image、非 root／限資源、明確 production storage、source／health 與候選獨立映像 |
| [活動摘要與導航檢查點](90-activity-sharing-checkpoint.md) | 共用摘要／安排分享、原文／時區／跨日、剪貼簿退路、目前及歷史地點與權限 |
| [統一統計檢查點](91-analytics-checkpoint.md) | 固定頁面／互動／API 結果、原文及參數排除、攔截公開客戶端與本機映像 |
| [簡繁顯示與原文邊界檢查點](92-display-language-checkpoint.md) | 最高優先語言協商、建置期靜態顯示、原文／提交值保全與 offline／PWA 回歸 |
| [動態提示與統一手冊檢查點](93-dynamic-language-guide-checkpoint.md) | 系統標籤／原例外／歷史原文、16 章共用手冊與 guide 舊入口、跨領域回歸 |
| [固定顯示片段與原文插值檢查點](94-display-fragments-checkpoint.md) | 選單／驗證／分享的固定片段、原生插值語意、ApiError 原文與複製欄位 |
| [統一政策與獨立同意紀錄檢查點](95-unified-privacy-checkpoint.md) | 完整用途說明、schema 15、舊同意保全、既有帳號確認、原回執與恢復 |
| [系統錯誤獨立顯示檢查點](96-system-error-displays-checkpoint.md) | 來源標記、可選 API 顯示、原例外／schema issues、原稿／回執保全及完整回歸進度 |
| [看板來源獨立對帳檢查點](97-board-reconciliation-checkpoint.md) | 固定 59 張來源表、逐列／序號／trigger、獨立刪除規格、bot 保全及候選損壞阻擋 |
| [成分來源封存與對帳檢查點](98-music-reconciliation-checkpoint.md) | 原會員／詞條、25 表獨立模型、身份精度、刪除／關閉與舊授權隔離 |
| [身份來源結構檢查點](99-identity-source-checkpoint.md) | 原 DDL／索引、rowid／儲存型別、序號高水位封存與獨立拒絕對帳 |
| [一致快照擷取檢查點](100-snapshot-capture-checkpoint.md) | 三服務停止／映像／來源路徑／重啟核對、flock／SQLite 寫入鎖、WAL／媒體／原歷史與 bot 證據 |
| [舊歷史備份下載檢查點](101-legacy-history-checkpoint.md) | 固定捕獲來源與匯入關聯、兩種原歷史下載、最新刪除／身份投影及原稿保全 |
| [新版看板回退投影檢查點](102-rollback-board-checkpoint.md) | 最新 59 表 SQL 精確投影、signed rowid／原型別／高水位、全部 bot 狀態與獨立拒絕對帳 |
| [最新成分回退投影檢查點](103-rollback-music-checkpoint.md) | 舊鍵／新鍵可逆對照、最新成分／建立／喊話／刪除與原始表示、獨立對帳及剩餘身份回退 |
| [完整回退來源快照檢查點](104-rollback-checkpoint.md) | 同一 writer lock 的完整新庫／最新 journal、全部表／rowid／原型別／高水位與跨領域固定來源 |
| [最新身份回退重建檢查點](105-rollback-identity-checkpoint.md) | 最新有效關聯／QQ proof、native recovery／contact／限流、原 rowid／audit 高水位與可逆追加映射 |
| [最新刪除紀錄回退檢查點](106-rollback-erasures-checkpoint.md) | 原關閉／成分 erasure 表示、完整 journal／reset scope、舊 Python 重播兩次與重設後新寫入保全 |
| [固定來源回退組裝檢查點](107-rollback-state-checkpoint.md) | 同一完整 checkpoint 的四領域組裝、獨立完整對帳、七產物 digest 與途中新寫入隔離 |
| [收款圖片與壁紙回退檢查點](108-rollback-media-checkpoint.md) | 同一 writer lock 的圖片／快照、最新壁紙／舊網址與原表示、私人原檔案／orphan 及舊 Python 元件讀寫 |
| [歷史備份保全檢查點](109-rollback-history-checkpoint.md) | 完整 raw capture／native histories 的 pins 與私人保全、最新刪除／身份／generated keys 投影、重置後新寫入及可選 paired ledger 下載修正 |
| [完整私人回退套件檢查點](110-rollback-package-checkpoint.md) | 全領域組裝／來源 pins、exclusive 0700／0600 與逐檔 fsync、完整 manifest／固定 reader／唯讀 CLI 及不完整輸出保全 |
| [最新 bot 外部狀態與持鎖封存檢查點](111-latest-bot-capture-checkpoint.md) | 最新授權／縮寫／日誌／屏蔽詞、原時間與 v2 私人套件、持續 SQLite／owner 鎖、跨程序競爭及失敗保全 |
| [離線回退封存與來源邊界檢查點](112-offline-capture-boundary-checkpoint.md) | reviewed input／停止服務 pins、v3 私人套件及 raw journal、完整持鎖 CLI／source 與 socket fences、late partial 保全及未協調邊界 |
| [最新 bot 外部狀態與原時間恢復檢查點](113-original-bot-state-restore-checkpoint.md) | v2／v3 最新 bot 原 bytes／奈秒時間落盤、缺失／休眠／uncertain 保全、固定 reader／CLI 與真 Python／TS 元件 TTL／群拒絕／詞庫驗證 |
| [舊成分歷史 namespace 與 HTTP adapter 檢查點](114-old-history-adapter-checkpoint.md) | 三種歷史 catalog、明確舊 HTTP overlay／proxy 管理限制、目前 erasure／身分投影及真 loopback 原 Handler 演練 |
| [實際 Docker 擷取證據檢查點](115-real-docker-inspection-checkpoint.md) | 真 Go-template／23 項 inert-container 檢查、原環境值等號保全／socket 身份修正、實際 Docker v3 封存及持鎖對帳 |
| [歷史看板資料與圖片恢復檢查點](116-board-history-restoration-checkpoint.md) | 原 DB／圖片配對、最新帳號刪除重播、native schema 13–15、獨立 59 表對帳及私人恢復產物 |
| [舊服務刪除紀錄保全與離線維護檢查點](117-erasure-authority-checkpoint.md) | 三 domain 原 byte authority、原 Python／HTTP overlay、程序中斷重播、獨立 TS reader 與明確離線維護入口 |
| [原生刪除紀錄續寫與啟動恢復檢查點](118-native-erasure-continuation-checkpoint.md) | 原 native byte baseline、checkpoint／lineage 綁定、持鎖續寫與重啟、舊站新增刪除阻擋、共用 codec 與生產來源建置 |
| [候選服務刪除保全配置檢查點](119-retained-authority-config-checkpoint.md) | production 強制 authority／checkpoint、獨立私人 bind、解析後 Compose gate、可獨立讀取的空映像 fixture |
| [舊站刪除紀錄向新版回放檢查點](120-forward-erasure-projection-checkpoint.md) | 原 authority bytes 與完整 checkpoint 綁定、原 ID／key／收據保全、離線刪除 footprint 回放與 Python 對帳；候選仍阻擋啟動 |
| [回退看板新寫入向新版合併檢查點](121-forward-board-merge-checkpoint.md) | 59 表三方合併、原流水號／歷史／bot 投遞保全、完整 native 專用資料及獨立 Python 對帳；跨 domain 恢復與啟動仍待完成 |
| [成分與身份新寫入來源合併檢查點](122-forward-music-identity-checkpoint.md) | 原成分／身份的三方來源合併、順序與 rowid 保留；原生業務重建仍須核對 |
| [看板與成分新寫入資料重建檢查點](123-forward-business-reconstruction-checkpoint.md) | 原生業務圖、revisions／receipts／來源保留；憑證與完整刪除回放仍待完成 |
| [合併後認領憑證與原回執核對檢查點](124-forward-proof-reconciliation-checkpoint.md) | 原找回 proof／device／PIN 與回執失效、原始私人映像保全 |
| [合併來源、原 ID 與身份審計重整檢查點](125-source-rebase-checkpoint.md) | 原成分 key／ID、來源映射、凍結歷史與 audit 高水位重新綁定 |
| [原始重設範圍與空會員 authority 檢查點](126-legacy-reset-authority-checkpoint.md) | 原五容器 reset scope、空會員 chain、TS／Python ledger 核對與匯出 gate |
| [已關閉帳號的離線恢復修復檢查點](127-account-erasure-repair-checkpoint.md) | 原關閉意圖／回執、私人 footprint、source-rebase 與 bot 工作保全 |
| [舊成分刪除意圖與原生恢復檢查點](128-legacy-music-erasure-checkpoint.md) | 原刪除紀錄匯入、實際 profile／key／時間、完整私人套件與 bot 保全；外部 ancestry 與完整切換仍待完成 |
| [舊帳號關閉與跨站回執合併檢查點](129-board-account-references-checkpoint.md) | 原帳號關閉授權、native orphan receipt 引用修復、獨立全列 verifier 與原 bot 投遞保全；完整 music／proof／epoch pipeline 仍待完成 |
| [原帳號關閉、完整業務重建與來源重整檢查點](130-account-business-source-rebase-checkpoint.md) | 原始來源先合併後清理、完整 business／proof／再次 rebase、十份原始來源與 parent bytes 保留及獨立核對；完整 reset／外部來源保全／實際版本組合仍待完成 |
| [166 項驗收台帳](capability-status.json) | 每項實作狀態與剩餘工作；未完整驗收不標記通過 |

## 原系統盤點結論

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

上一檢查點：[原始重設範圍與空會員 authority](126-legacy-reset-authority-checkpoint.md)，記錄原五容器重設 scope、空會員 chain 及未完成恢復時的啟動／匯出 gate；完整驗收與正式切換仍未放行。

- [已關閉帳號的離線恢復修復檢查點](127-account-erasure-repair-checkpoint.md)：原關閉意圖／回執核對、私人 footprint 修復、完整 source-rebase 與 bot 工作保全；仍不可啟動候選或部署。
