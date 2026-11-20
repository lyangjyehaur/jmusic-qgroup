# 原始重設來源的私有持久保存

日期：2026-11-20。發布範圍 **`none`**；恢復與遷移的相容性按 **`both`** 評估。不部署、不合入 main，沒有操作正式資料、憑證、群設定、真實待送工作或服務。

## 保存順序與使用邊界

第 139 號要求核對原 persisted JSON 與原 Python loaded snapshot，本次新增明確啟用的 `ResetSourceVault`。先在 authority、來源與 restore roots 之外獨佔建立私有 vault，保留其 manifest SHA；只接受同一個 authority instance 的舊服務 overlay。沒有環境變數、自動啟用、正式服務接入或保留期清理。

真正執行原 Python reset 時，依序寫入原 `persisted.json`、原 Python 編碼的 `loaded.json`，最後寫入 `snapshot.json`；每一步 fsync 檔案與目錄。完成且核對後才記錄 authority intent，然後才讓原服務清除身份與資料。snapshot 綁定 vault／authority／checkpoint、預定 sequence、previous record、原 operation 以及兩份來源 size／SHA。再次核對原來源與保存檔案後才准許繼續，不能把重設後已清空的資料當作操作前來源。

所有新檔案使用目錄 FD、`O_EXCL` 與 `O_NOFOLLOW`，只開啟剛建立的 inode，不覆寫既有目標。檔案 0600、目錄 0700；容量檢查在接受重設前執行，最多 1,000 captures、每份來源 64 MiB、總來源 128 MiB。未完成 capsule 原樣保留並阻擋後續 capture；已完成但未綁定的 capsule 保留並計數。已提交 intent 後若保存檔遭修改，保留 intent、原業務資料及受損保存檔，拒絕再次重設，不自行刪除或重試。

讀取既有 vault 檔案在隔離 Python 子程序進行。父程序只做 metadata fences，避免關閉可能被換成 live SQLite inode 的額外 FD 而釋放父程序的 POSIX 寫入鎖。TypeScript reader 核對完整 authority 與 vault tree，再把原 bytes 交給第 139 號雙來源 verifier；不啟動舊網站、bot、網路或資料庫。

這只完成原始快照的持久保存與核對。外部 custody／保留期、重設世代 ancestry、後續寫入／key reuse、身份重建與完整業務合併仍未完成；`resetGenerationsReconciled=false`、`externalRetentionVerified=false`、`releaseEligible=false`。vault 不參與公開下載或普通備份，既有 startup／structured reset gate 保留。

## 本機驗證

完整原 reset authority 40 項、雙來源 18 項與最初 vault 22 項合計 **80 項通過**；隨後新增的容量／不完整 capture／root 與 instance 綁定／record boundary 損壞 **6 項通過**，共 **86 個不同案例**。後一份 report 的 22 個未選案例為 filter 排除，其通過證據在前一份完整 report，不把 filter report 當作完整檔案結果。strict 與功能台帳檢查通過。

原始失敗 report 保留：67 passed／13 failed。真正原因是測試中原 Python `save()` 依一般 umask 建立 0644 檔案，第二次 reset 被私有來源檢查拒絕；隔離測試改為 0077 umask，沒有降低來源權限規則或公開內部例外。兩次真 reset 的 persisted／loaded 差異、未知欄位、`1.0`／負零／exponent 保留均通過。

7 個真 Python exit 位置涵蓋來源檔／snapshot／authority record／head／service ledger 的持久化邊界；不完整 capture 不讀入，record 已 fsync 的 intent 經原 authority 恢復後才讀入。來源／身份副本與原生 DB／五種 bot outbox 狀態均核對。另以小型 live SQLite 主檔 inode 取代 vault header，確定隔離 reader 實際開啟並讀回後，父程序寫入鎖仍使另一程序無法 `BEGIN IMMEDIATE`。

新的完整 unit inventory 預期 **152 檔／2,409 項**，browser 仍 **78 檔／833 項**。本機 focused 結果不替代新固定來源的完整 CI。

## 固定 Linux 證據

[第 138 號 run 44675054259](https://github.com/lyangjyehaur/jmusic-qgroup/actions/runs/44675054259)，來源 `0f6dc8f1fc6ee9d79a33a9cedb08928bb665888f`：browser job 已成功，完整原 report 的 **78 檔／833 項**與預期 ID／title／location 相等，每項 passed once，零 skip／retry／flake。artifact `14603660661` ZIP SHA256 `111ac48bc96fe8af09b4e5795c3340addff7964f7f864f7f9fd535086dd24eeb`，GitHub digest、CRC 與全部 97 個解包檔案 bytes 已核對；unit 尚未終態，因此整體 run 未宣告成功。

該 browser artifact 的原 Python＋compiled development web report 另核對 55 個原 Git blobs、175 個實際 runtime inputs、兩個 bundle pins、fixture／scenario、三模式全部 counters／原 dispatcher／callback、52 個連結與不重播已送／模擬工作的語意。development commit／tree 維持 null，不當作實際映像的來源宣告。

[第 139 號 run 44676623525](https://github.com/lyangjyehaur/jmusic-qgroup/actions/runs/44676623525)，來源 `11934abb238f938f3f7099dfad35ea7d91474170`：實際雙映像 job 成功並已獨立核對。web `sha256:c3ee31af60e793b71ebff2ebb11dd4d215d439d462a33fcec91cac136dc36916`；固定 Python `sha256:898078df3a2aadddd9bfcbe48c8dd176ffb316befba2e9cc27cb0b8a96ca0e66`。artifact `14601489995` ZIP SHA256 `d071ac4200008ef1f53d71acff496273ba90dde160a8fe9ae83cb80c34823b12`；pair report SHA256 `2d67fa18749124a7384352398fe9efdb3e93f09bb2741047008764bdcd92a127`。原 Dockerfile／websockets 17.4、原 55 blobs、三模式 dispatch／callback／投遞、85 HTTP／10 fixtures／52 shells 及退出清理通過；完整 unit／browser 仍待終態。

以上固定舊 Python 是盤點版本，不是目前線上 bot 身份證明；合成投遞不是實際 QQ 或完整 B01–B15 驗收。第 137 號已成功的完整結果與第 136 號歷史失敗仍分別保留，不套用到本次新增程式。

## 尚未完成

166 項仍 `in_progress`、0 項 accepted、`release_eligible=false`。完整 music erasure／舊與原生全域 reset 世代、外部 epoch ancestry／custody／高水位、私人歷史 latest-erasure、media／browser pending／proof、真正停止來源的 capture、完整 TS bot＋實際 web 版本組合／B01–B15／實機 QQ／正式規模，以及 audited activation 仍須完成。
