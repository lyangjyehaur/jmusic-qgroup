# 退休恢復的原認領證據驗證

日期：2026-11-20。發布範圍：`none`；本批修改隔離退休恢復來源投影並新增原 reset／認領 fixture 與驗證，不改 runtime、schema、bot 或任何正式設定。

在原 checkpoint、authority 與 reset source vault 建立之前，以實際 `createMusicClaims` 完成 pending、authorized、completed 三種原 native 轉換；QQ proof 由合成、本機已消耗的 login attempt／external identity 代表，不聯絡 provider。每個 fixture 再經真正原 Python reset、原 Store startup 與後續兩邊新增，最後執行第 151 號 retirement／global reset／business／proof／source rebase 及其獨立整組 verifier。

退休步驟與 retained business image 保有原 claim 完整 rows。pending／authorized 的 current claim 被 retire，原證據在獨立 retained image 中；已消耗的 QQ attempt 與 external identity 保持逐列相同。completed claim 只更換 current token 的關聯，保留原 target account、attempt、app、subject、rowid 及其餘全部原欄位，原 device 無法再取得請求。原 profile 擁有者解除、music epoch 增加，原保存回應為 410，原 receipt 與不可變歷史保留。此為權限失效，不能把其帳號引用當成必須刪除的隱私內容。

新增 **14／14** 案例通過；原退休整組與原 reset 回歸 **77／77**，共 **6 檔／91 個不同案例**。原固定宣告與新測試 AST 展開結果逐名核對；重跑不重複計數，原失敗嘗試保留。strict、功能台帳與 diff 檢查通過。本批全量固定來源預期 **166 檔／2,657 unit**、**78 檔／833 browser**，仍須核對完整 CI。completed 案例另在顶層 verifier 驗證重新釘選且恢复為 200 的 board disposition 仍會被拒絕。每個案例核對 `profile_unavailable` 處置理由、原認領當時的有效狀態、原 image／claims／consumed OAuth／receipts／歷史及 bot 工作；最終正常服務仍拒絕 recovery candidate。pending／authorized 在此原 reset 時間線也可能已有 claim expiry，測試不宣稱只有退休單一原因導致失效。

新增 `prepareRetiredResetBoard` 與獨立逐表 oracle，修正退休 native 回應已為 410、原 old board 仍保有 200 時，三方合併將它錯認為舊站新寫入而恢復回應的情況。先驗證完整 native retirement，再從原 paired receipt 決定允許失效的 key；只對仍符合原始內容的舊回應替換 status／body，保持其原 rowid、其他 storage classes 及全庫其他 rows。已失效的回應不再重寫；原舊回應已移除時不合成新 row；內容／簽章已變更則拒絕並保留全部來源供核對。完整原 old board image 另行保留，report 不能授權發布。新 source environment 和頂層 verifier 均接入 board disposition，不能藉 re-pinning 讓回應回到 200。

第 151 號固定提交 `a59daa2cc1881deb327e02cb7fc1235ce7cefd80` 已雙遠端同步，run `44749557550` 正在執行完整 CI。image job 已 success；原 image ZIP `74f3ec730137990e47f06eb16ecac384037356e3a7adbc9b864cd89d4cfdfd3a` 經 metadata digest／size、CRC 及所有提取 bytes 核對，image pair 亦独立核對 55 個原 Python blobs、manifest／harness、三模式、85 HTTP calls、10 次原 worker、52 入口及清理。browser job 已 success，原 browser ZIP `1e047ebc03c0457c700303c92e2a3082dcd7b443d4734ce568fbb50a17a460c9` 的 metadata digest／size、CRC、所有提取 bytes 及固定 78／833 inventory 已獨立核對，零 skip／retry／flake；compiled development Python 另核對 176 個 runtime inputs 與原 blobs、三模式 counters／dispatch。unit 及完整 run 的 terminal 結果仍須核對。

完整來源鏈／high-water、reset 後續世代／重複 epoch／exact key reuse、latest-erasure 私人歷史、外部 ancestry／custody、media／browser pending、停止來源 capture、正式規模、完整 TS bot／實際版本組合／B01–B15／QQ 與 audited activation 均未完成。166 capabilities 保持 `in_progress`、0 accepted、`release_eligible=false`。保留 Python bot，不合入 `main`、不部署。
