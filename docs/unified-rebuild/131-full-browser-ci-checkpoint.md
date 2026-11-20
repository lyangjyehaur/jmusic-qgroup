# 完整瀏覽器回歸與 Linux CI 檢查點

日期：2026-11-20。發布範圍 **`none`**。本輪修改測試工作流程及證據文件；web／API／Python bot／TS bot 運行程式沒有改動。不部署、不合入 main，不操作正式憑證、群設定或真實待送工作。

## 完整瀏覽器證據

固定來源 `a4d25204434a5c749718cf2f6de19c3d05b53e3f`，核對 1,027 份非文件來源及 11 份實際建置 web assets。78 個 spec 檔、832 個案例分 20 批執行，每批一個 worker、零 retries；全部通過，沒有漏跑、跳過、失敗或 flaky。環境為 macOS Google Chrome 157.0.8103.79／Playwright 1.65.1，使用實際 React 建置產物及 source API，每個 test 的 preview fixture 擁有獨立合成資料庫與程序。

私人目錄：`/Users/danersaka/.codex/rebuild-verification/browser-131-860577d2441549bca03231087bffee81/`。plan SHA256：`0fafd9af73dcab6f438f3e85d1dac11c1c9a80baa4c2cc90d5f70c338bb1fe6f`；runner SHA256：`32a1bae07716aadaca51d90f6a02c32c1fa035b5f36b6dacb21be1eb0db82c73`。每批先做 exact filename discovery，再核對 case IDs；獨立 verifier 重讀所有 discovery／result、來源／assets／Chrome／client pins，確認每個宣告案例恰好通過一次。保存 96 張截圖與完整批次輸出，結果見 `independent-browser-receipt.json`。

832 項包含公開 Umami 真實 client 的額外測試。只讀取公開 `https://u.danndann.cn/script.js`，4,655 bytes，SHA256 `1ad1145d19d4558c20f5469ca4a5fc50a1a46f860858c9c91bfcd56fd29a522a`，與第 91 號記錄相同。測試攔截全部 tracker transport 與 production-shaped navigation，事件不送至外部；驗證真 client 接收到的清理後 payload。未提供 client 時的普通 inventory 為 831 項。

人工查看本次有效來源的音樂工作區手機、我的成分桌面、活動桌面、bot 管理手機及帳本手機截圖。共用導航、活動返回、選取／保存狀態、欄位與必要提示可辨識，未見水平溢出或遮蔽操作；帳本窄欄的「店家淨支出」仍有末字換行，尚不構成功能缺失。這是代表性視覺核對，不能取代全部裝置與可及性驗收。

較早 `browser-131-b08c6afcb79648dbae2e1cb7874b3dcc` 使用 substring CLI regex，可能多選 `durable-*` 檔，已停止且只保留為開發證據。正式清單改用 escaped basename＋路徑邊界／結尾匹配，逐批 discovery 的 IDs 必須等於 plan；本次 832 項結果不計入舊批次。

能力台帳的 browser-reference audit 覆蓋全部 78 個 spec；157 個能力有直接 browser 引用，B01／B02／B03／B12／B14／O01／O11／O14／O15 為 backend、bot 或運維領域而沒有直接 browser 引用。引用與案例通過不表示原需求逐項已完成正式驗收。

## Linux CI 問題與調整

GitHub 原提交的 [run 44647481104](https://github.com/lyangjyehaur/jmusic-qgroup/actions/runs/44647481104) 在原 15 分鐘 job 期限被取消。unit 測試尚未完成，build／smoke／browser 全部 skipped，不能宣稱 Linux 通過。取消前六個檔已有失敗：board history 18、source rebase 42、capture package 1、rollback package 1、account business 7、bot restore 2。失敗案例多在預設五秒附近，但 run 沒有最後 failure stack，目前不能認定全是 timeout。

CI 改為獨立 unit 與 build／smoke／browser jobs，各 90 分鐘期限。unit 使用一個 worker，保留原測試 timeout 與全部 assertions，保存完整 JSON report；browser 沿用一個 worker／零 retries，禁止 only，固定上述 public client SHA，保存 JSON report 與截圖／失敗 trace。兩個 jobs 成功與失敗都上傳 evidence，避免 unit 失敗讓 browser 從未執行。這是 CI 執行與診斷修正，不是已取得 Linux pass；提交後須讀取實際新 run 的 terminal 結果，處理真實失敗並獨立核對完整 inventory。

## 保留門檻

本輪 browser evidence 綁定第 130 號完整來源；本提交只有 CI／文件改動，沒有更新 runtime。既有 Python bot 繼續保留。本機瀏覽器案例、模擬 QQ 與版本 SHA 不能代替固定 Linux 映像與切換後實際 bot 的組合驗收。

完整 music erasure／structured reset generation、epoch ancestry／外部 custody／高水位、私人歷史 latest-erasure 存取、media／browser pending／proof、真正停止寫入的 capture、Linux web＋Python／TS bot 版本組合、B01–B15／實機 QQ／資源及 audited activation 仍需完成。全部 166 項能力維持 `in_progress`，0 項 accepted，`release_eligible=false`。
