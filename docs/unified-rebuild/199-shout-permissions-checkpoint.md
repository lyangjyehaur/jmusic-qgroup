# 找搭子權限與跨程序併發驗收

日期：2026-11-22（Asia/Taipei）。變更範圍：`none`；實際部署：`none`。新增測試與隔離 fixture，運行程式、schema、outbox、設定及網址沒有修改；未整合 main，保留 Python bot。

## 本輪驗證

`apps/api/testsupport/shout-permission-matrix.test.ts` 新增 78 個案例。40 個「身份 × 活躍／歷史／未關聯作者／已移除」組合涵蓋成分會員、活動協辦、無成分會員、有／無成分的帳號管理員、兩個獨立救援工作階段、訪客與未登入者。會員列表及詳情需要目前成分資格；管理身份不提供發布資格，活動協辦也沒有管理例外。作者資料使用目前稱呼與聯絡來源，不暴露私人留言、性別及原識別。解除帳號關聯保留成分身份；隱私刪除依既有 schema trigger 一併清除該作者的活躍與歷史內容。

發布、管理刪除與回執核對目前 scope、Origin、會員 CSRF 及管理 CSRF。已成功操作在装置撤權、管理撤權／重授、救援到期、憑證輪換及重新登入後，不能藉舊回執恢復原管理權限。回執查詢只回傳 committed；另一管理員、另一救援工作階段及一般會員看不到原管理回執。

5 個真正跨程序案例讓兩個獨立 API 進程共用測試擁有的檔案資料庫，各自完成 session／CSRF 初始化並到達 IPC barrier 後，同時開始交易。不同 UUID 發布得到 200／429；同 UUID、同內容得到相同成功 ID；同 UUID、不同內容得到 200／409。相同刪除操作兩邊成功但只有一筆刪除及回執；不同刪除 UUID 得到 200／404。沒有 HTTP listener、真實 QQ transport 或正式憑證。

成功刪除核對 native row、兩份原 music_documents 副本與 migration_map 狀態，不在刪除紀錄或回執複製作者內容。每次讀取、拒絕與重試比對全部使用者資料表；成功操作只允許指定業務表變化，bot 的 pending／sending／sent／failed／skipped、claim、重試及模擬狀態完整保留。兩個 receipt insert 失敗案例確認發布及刪除的全部業務寫入會回滾，修復後可用原 UUID 重試。

## 結果與證據

5 個 unit 檔案／98 個案例通過，包含新增 78 個案例及原喊話、管理回執、domain、migration 回歸；TypeScript strict 通過。3 個 browser 檔案／30 個原案例一次通過，0 重試／跳過，涵蓋列表與複製退路、持久草稿、關頁恢復、刪除及管理回執。原喊話回歸仍核對 Python archive／bot view 與投遞表保全。

獨立宣告的 inventory 與結果逐項相同，完整 unit inventory 現為 198 檔／3,717 個案例；本輪未宣稱最新提交全套通過。初始 TypeScript fixture typing 與 erasure 預期錯誤的報告保留；erasure 預期依既有 schema trigger 修正，沒有降低隱私清除要求或修改運行邏輯。

隔離副本 78 個 control 案例通過；故意讓普通會員取得管理權，17 個案例抓到越權，61 個保持通過。移除發布冷卻限制，5 個案例抓到重複發布，包括真正跨程序競爭，其餘 73 個通過。副本還原並核對 226 個來源 pins；原失敗報告與獨立驗證腳本保留。證據目錄：`shout-permissions-199/`。

## 196 原完整 CI

原提交 `013c6e724e9d09bf70c51c757832e28f6a3b421d`／CI `44928466193` 的 unit、browser、Linux image 三個工作及全部步驟均為 success。原 195 檔／3,479 個 unit、81 檔／844 個 browser 案例一次通過，0 重試／跳過。原 ZIP 的 API digest、大小、CRC 及解包 hashes 已核對；固定 inventory、145 個契約來源輸入／54 個權限來源 pins、84 個 PWA 資源／1,777,913 bytes 相符。

從乾淨提交封存明確 196 來源，重新生成並核對原 browser 的 2 個 API bundle／184 個輸入、3 個 native bundle／107 個輸入，以及 image 的 Python source manifest 與 bot harness；沒有重建 image 或重跑原 CI。原 Python 的 55 個 blobs、原 Dockerfile、依賴與 harness pins 均對應精確來源。一般 browser runtime 為 development，由原 CI 提交與 bundle pins 綁定；actual image 的 web runtime 明確對應該提交與 tree `8bf72c78f0c29ebef254b377dff1f58c64c29a9a`。

原隔離 image 組合為 web `sha256:571b9a8a2fe3c0a57be64ed1ee92b33e63b6f5d98e75d911c3eb6380c56012f5`、Python `sha256:3d13b5ac54d3041be0335ec295ae6dfcde2569efa2beeb1e2e4fcddd1db5f1ee`。image 與 browser 的配對報告各包含 71 次原 worker、9 次 native consumer、314 個深連結與 532 次 HTTP 呼叫，其中 2 次限流延後；原重試、不確定投遞、模擬及順序交接語意已獨立核對。證據：`payment-permissions-196/`。外部投遞仍為 synthetic 且 transport 被拒絕，這不是線上 bot 實際版本組合或完整 B01–B15 驗收。

這仍是部分領域驗收。166 capabilities 仍為 0 fully accepted，`permissionBindingsComplete=false`、`releaseEligible=false`；C01／C02／C03／A12 只補入本輪證據及已驗證的併發項目。完整來源對帳、舊入口、備份／還原、QQ WebView、實際線上 bot 版本組合及 B01–B15 仍需驗收，依使用者要求，不部署。
