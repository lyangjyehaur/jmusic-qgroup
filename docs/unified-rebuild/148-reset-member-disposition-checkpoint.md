# 消失會員的私人處置與原資料保全

日期：2026-11-20。發布範圍：`none`；隔離遷移工具、fixture 與驗證，不發布服務。

## 已實作

新增 `prepareForwardLegacyResetMemberDisposition` 與獨立 verifier。對完整、已釘選的原 reset vault 逐次核對 persisted／loaded／completion，將 persisted-only 會員分成目前仍在原 Store 恢復結果、已有實際刪除 authority、或只能保留為歷史資料三類。只有最後一類產生 `retained_history_only` 處置；不由 session、prelink 或 entry intent 建立有效會員，也不偽造 privacy erasure。

私人產物包含最新原 JSON、完整原 identity image、每次 reset 的原 persisted／loaded／completion bytes，以及消失會員每次出現的完整 payload、來源與 completion pins、存留身份記錄的表名與原 rowid。同一會員在兩次 reset 前具有不同內容時，兩份資料分別保留。payload 由 Python 從原 bytes 提取，保全未知欄位、整數／浮點型別、負零與欄位順序；不經 JavaScript JSON 序列化。所有這些內容只存在於離線私人產物，不寫入有效會員或啟用憑證。

writer 執行真正原 Store 的恢復流程以辨識仍能恢復的會員；verifier 不重跑 writer 或 Store，從原 JSON 與唯讀身份 SQL 獨立推導全部輸出、身份引用、分類、來源 bytes 與回執。輸出重新釘選、刪減 occurrence／coverage、替換身份 rowid、改變 `1.0` 型別或復活消失會員都不能通過。來源、vault 與輸出邊界持續受檢查；有明確容量上限，超出時拒絕並保留來源。

## 驗證

新增 **15／15** 案例通過。fixture 使用真正原 reset，涵蓋兩次 persisted-only 數字會員、未知巢狀欄位與 scalar types、殘留憑證、再次出現在最新資料的數字會員、可恢復 native 會員與實際刪除。原會員範圍／身份會員／整組恢復 **69／69**，原 proof 恢復 **3／3** 通過；固定 inventory 與三份原報告逐名核對，共 **5 檔／87 個不同案例**。strict、台帳與 diff 檢查通過。完整來源預期 **161 檔／2,602 unit**、**78 檔／833 browser**，不是本機已通過全量的宣告。

第 146 版固定 `8e181256f76e0b5cc9588d294aee91068fe323f3` 的原 browser ZIP 已按 GitHub metadata digest／size、ZIP CRC 與全部提取 bytes 核對，再獨立比對完整 **78 檔／833 案例** 的 IDs、名稱、位置與逐次結果：全通過，零 skip／retry／flake。其 compiled web 與固定原 Python 的 development 報告另核對 55 個原 blobs、175 個 runtime inputs、三模式 counters／dispatch 與 52 個網頁入口。unit 尚未終態，不記成整組成功。

第 147 版固定 `46094315170f2b7f2914da0baa28788f53b87edc` 的原 image ZIP 同樣完整核對，再核對兩個實際隔離映像、55 個原 Python blobs、manifest／harness、三模式與原 dispatch、85 HTTP calls、10 次原 worker、52 個入口及清理。此為固定原版本的隔離演練；不是實際線上 bot 版本或 QQ 驗收。browser 原 ZIP 已完整核對，**78 檔／833 案例** 逐名及逐次結果通過，零 skip／retry／flake；compiled web 與原 Python development 報告也獨立核對。unit 尚在執行，整組 run 仍未完成。

## 仍須完成

本次完成原資料保全與明確的私人歷史處置，**尚未把消失會員處置接入 native 有效會員模型及完整 business／proof／rebase 候選**。回執保留 `nativeDispositionApplied=false`；第 147 號的 startup／完整候選門檻繼續拒絕此情況。不能以這份私人產物跳過門檻或把被移除會員復活。

下一步須在不冒用 `erased_at` 的前提下表達 reset 後失效狀態，保全 native profile、所有不可變 audit／history、原身份与鍵預留，並處理有效名冊／匹配／統計／認領／登入／bot 網頁入口及回退投影。若 native fork 已有該會員的新寫入，必須先對帳，不可直接退役或刪除；遺留憑證不能因此取得新版登入權限。歷史存取仍須最新刪除、權限與 ancestry／custody 驗證，私人 raw sources 不能直接變成可下載歷史。

其餘完整計畫的來源鏈／high-water、media／browser pending、停止來源 capture、正式規模、實際候選版本組合、B01–B15、QQ 與 activation 驗收仍未完成。166 capabilities 維持 `in_progress`、0 accepted、`release_eligible=false`；保留 Python bot，不合入 `main`、不部署。
