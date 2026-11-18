# 第九十批實作：系統錯誤的獨立顯示提示

日期：2026-11-18（Asia/Taipei）。分支 `codex/unified-rebuild`。變更範圍先按 **`both`** 評估：共用 domain 的例外增加顯示 metadata，API／前端與建置鏈一起調整；實際候選 web／bot 組合尚未驗收。實際發布範圍 **`none`**；沒有合入 main、部署、改動正式 bot、憑證、群設定或真實待送工作。

## 原始例外與顯示分離

API 仍回傳原 `code`、`message` 和 HTTP status。只有在來源明確標記的固定系統錯誤，額外回傳 `messageDisplay: { hans, hant }`。原始訊息不依 Accept-Language 改寫；舊回應不帶這個欄位仍可使用。前端 `ApiError.message` 保留原文，畫面透過 `errorText()` 讀取另外的顯示值，既有帳務、權限、恢復及回執判斷保持原值。

API／共用 domain 合計 **361 個標記**：348 個 API constructor、13 個共用 constructor；生成 **285＋13 組**固定顯示。以 TypeScript AST 去除標記及新增 import／export 後，58 個檔案與上一提交完全相同；`app.ts` 原 4 個 DomainError constructor 保留，另外用 3 個 constructor 編碼原本的輸入格式、Fastify／限流與未預期失敗回應。這三條仍使用原 code、message 及 reply status，未預期例外仍記錄原實例。

`withApiError()`／`withDomainError()` 僅為原實例加入 WeakMap metadata，返回同一個 Error，不重建例外、不改 stack、cause、類別、status 或 code。建置器只接受固定 code 與固定 message／條件分支的原 `new DomainError`；变量、插值、字串拼接及在 catch 端推測來源都拒絕。未標記的訊息，即使與固定訊息字面相同，也不因 catch lookup 被轉換。帶會員名稱等資料的動態錯誤保留原文。

OpenCC 只在建置時生成顯示對。API 顯示表留在後端；共用 domain 僅含 13 組。已檢查前端產物：285 個 API 字典鍵均未打包，未找到 runtime converter。未改動資料庫結構、持久例外／audit、payload 簽章、回執、bot 模板或 protocol 值。

## 前端與恢復

一般 API、收款圖片與管理下載共同使用 `apiFailureError()` 接收可選顯示值。失效帳號、401／403、未知結果、重試與下載授權仍依原 ApiError 判斷；沒有因提示文案擴大權限或自動重送。

網路、JSON 解析與成功回應 schema 不符時，`displayError(original, '固定提示')` 只加入簡短核對／恢復提示，保留原 TypeError、SyntaxError、ZodError 與原 issues。不是 ZodError 的 schema 例外及非 Error 拋出值保留原行為。

直接繼承原生 Error 且有固定 `super('literal')` 的 constructor，在原 super 之後加入 metadata；parameter properties、欄位初始化、cause 和原 message 比較不變。動態 super 與其他 superclass 保持原文。装置連結／刪除衝突因此可顯示簡繁提示，仍是原衝突類別。

帳本分頁原本先攤平成訊息再建立 Error，改為保存原例外，保留其顯示 metadata 與重試來源。已確認帳本、款項申報與游標語意不變。

## 隔離驗證

- Strict TypeScript、production React／API／bot build 通過。主 JS **1,482.05 kB／gzip 432.87 kB**；guide **46.22 kB／gzip 15.90 kB**、CSS **123.35 kB／gzip 18.83 kB**。bundle 過大警告仍在，效能尚未完整驗收。
- 原生完整單工 **963 項／115 檔全數通過**。包含实际 HTTP 找不到／Zod／malformed JSON／資料表不可讀的 500、舊／新錯誤契約、例外身份與 stack、編譯後 subclass／Zod issues、網路與 JSON 原例外、analytics outcomes，以及既有 Python bot、投遞、帳務、遷移及恢復差分。
- 首輪完整命令漏了 npm 的 `--`，單工參數未傳給 Vitest，出現 20 個逾時／相關失敗及 1 個 worker 啟動錯誤；該輪 934 通過不算驗收。修正命令後完整單工通過，未放寬測試期限、減少資料或略過 bot 案例。發布來源拒絕訊息屬既有負向測試，沒有發起發布。
- 新增雙語瀏覽器 **14 場景全數通過**：實際 API 找不到與 scope 拒絕、實際稱呼 revision 衝突、malformed schema 的原稿保全、未標記的原文、刪除雙分頁衝突／原憑證保全、已提交但回應不符的原 UUID／payload 恢復、管理下載確認及零檔案釋出、圖片錯誤／重試及其他原圖保留。首輪使用舊前端產物、錯誤備份 ID 格式／scope 提示預期及沒有圖片的 fixture 入口，另遇瀏覽器啟動逾時；重建並修正案例準備後通過，未移除保全斷言。
- compiled smoke 通過空合成庫的 API／SQLite／sharp、配對備份與歷史匯出、blocked recovery、bounded room worker；原生 bot mock HTTP／WebSocket／ACK／Resume／未知投遞／simulation／CLI／SIGTERM 均通過。沒有真 QQ 連線或投遞。
- 全套瀏覽器回歸 **829 場景／77 檔**已開始，結果待完成；不能以 14 個新場景代表全站操作驗收。

暫存記錄：`/tmp/qgroup-error-displays-native-single.log`、`/tmp/qgroup-error-displays-build.log`、`/tmp/qgroup-error-displays-browser-new2.log`、`/tmp/qgroup-error-displays-browser-full.log`、`/tmp/qgroup-error-displays-smoke.log`。AST 比對腳本為 `/tmp/qgroup-audit-error-wrappers.mjs`。這些是本機驗證紀錄，不是正式發布證據。

## 待完成

保留 **166 IDs、166 in_progress、0 planned、0 完整驗收，release_eligible=false**。未標記的固定 helper／驗證訊息、API 通知／安排／結算及持久舊稿系統 notes 顯示仍須逐項處理；不能全文轉換使用者或持久資料。全站瀏覽器回歸、來源對帳／遷移／新寫入回退、完整 B01–B15、實際候選 web／Python 或 TS bot 組合、效能、實體裝置與 QQ WebView 持續處理。現有 Python bot 保留，本批不代表重構完成，依使用者要求先不部署。
