# 圈子與分房共用計算名額

日期：2026-11-22（Asia/Taipei）。變更範圍：`web`；實際部署：`none`。Python bot、schema、outbox、共用設定、既有網址及演算法保留，沒有修改正式服務、憑證或待送工作。

## 共用計算與取消

網站在同一 API instance 建立共用 music compute budget，圈子與分房合計最多兩個 worker，沒有等待佇列。兩個圈子、兩個分房或一個圈子加一個分房均佔用相同名額。名額在原生 thread 終止後釋放；退出事件與 terminate 回執的重複完成不會重複歸還。啟動失敗、驗證失敗、逾時及取消保留既有錯誤提示。無法確認 thread 已停止時不提前歸還名額。

圈子及分房的忙碌判定先核對目前 session／scope、成分資格，分房再核對寫入來源／CSRF 與活動存取權。飽和的計算請求在讀取全站詞條／選擇之前返回 503；查詢來源和計算後的資格／來源重驗仍可讀取，不要求另取 worker 名額。資格檢查只讀取本人有效 profile ID，不再額外載入本人全部選擇。正常來源 hash、正式名冊、選擇、結果與排序保持原語意。

分房現在與圈子一樣監聽實際 HTTP 斷線，取消在途 thread，移除監聽器並拒絕晚結果。分房 worker 也使用空環境及獨立啟動參數，拒絕意外繼承 API 環境；不傳入資料庫 handle、憑證或網路 client。原生 worker 執行期限仍為五秒；圈子的 old／young／stack 限制為 128／16／2 MiB，分房為 64／16／2 MiB。

這限制一個 API instance 的計算 thread 數及各 thread 的 V8 heap，並不是程序 RSS／全站 CPU／多副本總配額。來源查詢、序列化、複製及其他 API 仍在主程序；正式總資源與部署規模驗收沒有因此通過。

## 驗證狀態

7 個 targeted unit 檔案／55 個案例通過，新增 9 個案例。使用真實原生 threads 驗證跨功能飽和、混合計算、取消後才回收名額、逾時與驗證失敗、關閉與不同 API budget 隔離，以及分房空環境正反控制。HTTP 測試保留真正完成結果及退出事件，沒有合成 worker 回應；涵蓋兩種飽和方向、資格先行、飽和時不讀全站詞條／選擇、健康查詢、資料唯讀及真正 fetch 斷線。原圈子來源變動／撤權及分房／結算回歸通過。

初始 HTTP fixture 只選一人，違反既有至少兩人條件，造成驗證失敗及等待不存在的 worker 逾時；已修正 fixture 並在準備階段驗證請求，原人數限制與失敗報告保留。後續飽和查詢測試發現資格檢查原先也載入本人選擇，實作已改為等效的有效 ID 查詢，完整斷言保留。

strict TypeScript、建置與建置後 smoke 通過。六個 compiled runtime bundles 獨立重現，API／圈子／分房 union 為 190 個 inputs，native consumer 108 個。195 個請求與成功回應契約及 317 個 schemas 保持相同；150 個契約來源 inputs、68 個權限來源 pins 已核對。除圈子／分房的計算及來源邊界之外，其他操作語意保持相同；只移動的程式行號不當成契約差異。85 個靜態／PWA 資源、1,786,204 decoded bytes 與第 201 號逐項相同。

6 個 browser 檔案／53 個既有案例通過，0 重試／跳過；原案例 ID、名稱、行列位置逐項保持。涵蓋圈子、自由／活動分房與持久原稿、正式包間、結算及頁面載入。固定原 Python bot `8da877857f163853c449474e168534e2e493121b` 與最終 compiled API 的隔離組合通過：55 個原 blobs、71 次原 worker、9 次 native consumer、314 深連結及 532 HTTP（2 次限流延後），域、恢復與順序交接的獨立 oracle 全部通過，無真實 QQ。這不代表線上實際版本或全部 B01–B15 已驗收。

完整宣告 unit inventory 為 204 檔／3,771 個案例，第一次完整執行為 3,770 passed／1 failed，0 skip；唯一失敗是舊恢復驗證的 rebase-row corruption 案例超過原有 30 秒。相同來源與時限單獨重跑該檔的 44 個案例全部通過，原失敗案例約 2,916 ms。第二次完整回歸單獨執行，204 檔／3,771 個案例全部通過，0 skip，耗時約 2,141 秒，原失敗案例約 2,994 ms；獨立 Python 核對全部案例名稱與檔案，固定 inventory 完全相同。沒有修改測試、斷言或時限；原失敗報告與完整 inventory receipt 保留，尚未確定首次逾時原因。證據存於 `/Users/danersaka/.codex/rebuild-verification/music-compute-202/`。

合成 API 量測使用獨立暫存 DB、真正 compiled API 與觀測 preload；preload 記錄真正 worker 的啟動／退出及程序指標，不提供合成回應。固定 seed 42、1,000 人、2,000 詞條、最多 20 選擇及 40 人四房的資料，兩個圈子與圈子加分房兩種情境均維持 peak 2 workers，額外計算返回相應 503，全部圈子及分房結果完整核對。worker 環境及啟動參數為空，關閉後 active 0，synthetic bot outbox 仍為空。

本機 Darwin arm64／Node 22.22.3／8 logical CPUs／16 GiB 上，圈子 HTTP 約 1,636–1,716 ms，混合分房约 614 ms，程序 sample peak RSS 298,598,400 bytes（約 285 MiB）。自由分房來源約 258 ms；計算期間 33 次健康查詢全為 200，median 約 1.2 ms、p95 約 196 ms、max 約 249 ms。主程序 10 ms heartbeat 的 sample max gap 約 337 ms，包含啟動及資料來源／回應處理，不能套用前輪直接 worker 的 15 ms。這是單次本機合成樣本及觀測值，沒有程序 RSS／CPU 強制限制或跨副本驗證；來源與回應的主程序成本仍須改進及正式量測，正式容量資格維持 false。

第 200 號原 CI run `44941734780` 已完成並獨立核對固定提交 `bcf2ee56f008ff2fa1ee262adcae8e76ca3df36f`：200 檔／3,746 unit、82 檔／857 browser 全部一次通過，0 重試／跳過，完整宣告 inventory 相同。三份原 ZIP 的 API digest、size、CRC 與抽取雜湊核對，147 個契約 inputs／60 個權限 pins 及 85 個 PWA 資源／1,786,204 bytes 相符。

原 web 映像 `sha256:ed68e3aabc96abcd94fa68e72c3ef895190916a8902a03b2efa6d7bbbffa8416` 與 Python 映像 `sha256:f14dd5b496a7e0d5fe95975058080e470fdebf100e08bb855f7defedbe0b7f8c` 的網路隔離組合通過；186 API inputs／108 native inputs、原 Dockerfile／websockets 17.4、七個確切公共 harness／設定 blobs 重生的 manifests 與 runtime pins 相符。原 browser／image 的 532 HTTP／2 次延後、55 blobs／71 worker／9 native／314 links 及三個獨立 oracle 核對。這些證據只屬該固定舊來源，沒有取消／重跑原 CI，也沒有重建映像。

前輪固定提交 `5178d455021fdfe1fe27dabdb83c99d7c9a229ab` 的 CI run `44945051698` 已完成，isolated-unit、isolated-image 與 isolated-browser 均為 success；此處僅記錄 GitHub 執行終態，不把它當成本輪来源的完整驗收。

166 個既有能力及 U01–U03 均保留，0 fully accepted，發布及權限完整性 gates 維持 false。完整來源對帳、正式規模與程序／多副本資源、QQ WebView、切換後實際 bot 版本組合及 P6／P7 驗收仍未完成，不部署。
