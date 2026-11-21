# 分房權限與計算完成後撤權

日期：2026-11-22（Asia/Taipei）。變更範圍：`none`；實際部署：`none`。新增驗收測試及測試輔助程式，修正既有測試的時間競態；運行程式、schema、outbox、設定與網址沒有修改。未整合 main，保留 Python bot。

## 新增驗證

`apps/api/testsupport/room-permission-matrix.test.ts` 新增 80 個獨立預期案例。11 種身份涵蓋本人、參加者、名冊協辦、排程協辦、只有查看邀請的會員、無關會員、成分管理員、沒有成分的管理員、救援管理員訪客、訪客及未登入者。

55 個「身份 × 自由／公開活動／私人活動／草稿／已刪除活動」案例核對来源及 analyze、split、recalc 三種實際 CPU 命令。網站管理權不取代私人活動邀請或草稿職責，沒有成分的管理員也不能使用分房。資格與拒絕碼獨立宣告，沒有以 runtime guard 反推預期。

有效活動來源使用目前帳號關聯與穩定報名 ID，保留 confirmed、waiting、tentative，以及沒有成分的同行。同行可手動安排，但不混入成分評分。自由來源只使用實際成分 ID；來源版本綁定使用者，另一帳號的版本不能直接試算。試算／重算逐項核對參與者保全；來源與結果不夾帶私人留言、性別、聯絡 QQ、報名備註或憑證。只有符合條件的活動本人取得 canAdopt，協辦或管理員不能藉分房來源取得採用權。

15 個案例核對三種命令的 scope、精確 Origin 與 CSRF。另 10 個案例在**真實 worker 完成計算並準備回傳結果時**改變隔離資料，核對裝置撤權、私人活動撤權、草稿職責撤銷、私人活動換主人、本人失去成分、選取成分刪除、可見來源變更及活動刪除後不能取得原結果。同時保留兩種有效情況：私人欄位改動不影響試算版本，撤銷無關的網站管理身份不會取消會員原有的公開活動試算資格。

`room-worker-boundary.ts` 只觀察符合來源版本的原 Worker message，在 API 收到原結果前執行 fixture 變更；沒有製造計算结果、注入運行 hook 或改動 worker。每個計算後案例都確認原結果恰好觀察一次。既有 `music-rooms.test.ts` 的同一個撤權案例也改用此方式，移除兩個 15 毫秒時間差，保留其原驗證內容。

每個 fixture 擁有自己的檔案型暫存資料庫，bot 預設停用。讀取、試算與拒絕操作比對全部使用者資料表；計算後變更案例比對 fixture 變更完成後的完整快照，沒有額外寫入活動、帳務、通知、身份、回執或 bot 表。初始 fixture 的聯絡 QQ 唯一性與角色外鍵錯誤已修正為有效資料；原失敗報告保留，沒有降低 schema 限制。

## 結果與有效性

2 個 unit 檔案／87 個案例通過，包含新增 80 個案例及既有 7 個分房回歸；TypeScript strict 通過。既有回歸仍包含活動採用與原回執、原 Python room／bot view、投遞狀態保全、worker 上限及停止行为。2 個 browser 檔案／27 個原案例一次通過，0 重試、0 跳過，包含原稿、來源切換、撤權與隱私刪除。

結果逐項核對獨立宣告的新案例與既有固定 inventory；完整 unit inventory 現為 197 檔／3,639 個案例，本輪未宣稱最新提交全套通過。

隔離副本先通過 80 個 control 案例，再移除計算完成後的身份／來源檢查，8 個計算後撤權案例全部抓到應拒絕卻回傳 200。另一份 mutation 讓私人性別進入分房工作及來源版本，私人欄位變更案例抓到應保持有效卻回傳 409；其餘 79 個案例通過。兩份原失敗報告保留，副本還原後核對 223 個來源 pins；工作目錄的運行程式沒有修改。

## 194／195 原完整 CI 核對

原固定提交 `0487fb1faedb8d2fbae4c3973ba9b25bbe91c19b`／CI `44925187118`，以及 `8503dfb7249912c6881498dde033b6d673e0a3f1`／CI `44926719634`，unit、browser、actual Linux image 三個工作與全部步驟均為 **success**。194 的 193 檔／3,345 個 unit 案例、195 的 194 檔／3,419 個 unit 案例，以及各自 81 檔／844 個 browser 案例，全部一次通過，0 失敗、重試或跳過。

兩輪原 unit／browser ZIP 的 API digest、大小、CRC 及全部解包 hashes 核對相符，固定 inventory 完全相同。原契約仍與固定 191 產物逐位元組相同，145 個生成器輸入與 54 個權限來源 pins 對應各自精確 Git blobs；PWA 的 84 個資源／1,777,913 bytes 也一致。

每輪原 browser Python 報告的 55 個原 blobs、harness、71 次原 worker invocation、9 次 native consumer、314 個深連結及 532 個 HTTP 呼叫已獨立核對，均包含 2 次限流延後。各自 2 個 API runtime pins 從明確 archive 重新生成，184 個來源輸入核對相符。一般 browser runtime 為 development；版本由原 CI 提交與產物 pins 綁定。

兩輪 actual image／固定 Python image 的來源及 runtime manifest 也完成獨立核對；各自 3 個 native bundle 的 107 個輸入與原產物一致。195 配對使用 web `sha256:e6fe393ef1fd93c67e5f249727f8f04339f658190866b73dbbab9548fd6e1ef6`、Python `sha256:43717215bc34e1c0b125df1dfe82f23bc3c5a7319f3a40f6642088f80a3d27fc`，531 個 HTTP 呼叫包含 1 次限流延後。這是原隔離 actual image 的結果，不是正式環境版本組合。196／197 的原 CI 仍在執行，沒有取消或重跑。

證據：`room-permissions-198/`、`time-poll-permissions-194/`、`settlement-permissions-195/`。投遞仍為 synthetic，外部 transport 被拒絕；沒有驗收線上 bot 實際版本、真實 QQ 或完整 B01–B15。

本輪仍為部分領域驗收，`permissionBindingsComplete=false`、`releaseEligible=false`，166 capabilities 為 0 fully accepted。完整功能、來源世代、UX、bot 實際版本組合及切換／回退驗收繼續；依使用者要求，不部署。
