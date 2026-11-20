# 原始重設的會員與曲目投影

日期：2026-11-20。發布範圍 **`none`**，恢復相容性按 **`both`** 評估。不部署、不合入 main，不操作正式來源、bot 憑證、群設定或真實待送工作。

## 原生候選實作

`projectNativeForwardErasures` 現在接受明確的原 reset vault 設定。authority 中有 structured reset 時，全部操作前 snapshot 與真實完成結果必須完整核對；缺 vault 或 completion 仍拒絕。原 reset 的 loaded-member suffix 進入既有原服務刪除投影，產生綁定原 record／row／time 的匯入 marker，不製造原生管理請求、回執或重新執行管理入口。

曲目清除從每次 reset 真正被清空的 persisted JSON 推導。原 rollback checkpoint 的 JSON key 是實際 native entry ID；只清除該 checkpoint 內已存在且在原 persisted 範圍內的 ID、相關 selections／details／creation references／entry_source，並標記 migration map deleted。loaded-only 曲目不參與這個範圍，後來世代的新 ID 與無關原生曲目保留。原服務後來新增的 key 若撞到 checkpoint 外的原生曲目，停止候選並要求明確世代對帳。

完整獨立 row oracle 另從 authority scope 推導 ID，核對所有表、rowid、storage class、schema、pragmas 與 sqlite_sequence；不重跑 writer，不信任 counters。原 catalog actions、privacy receipts、活動／名冊／財務歷史及 bot 工作保留。再次以同樣來源投影應得到相同 rows／journal。來源 bytes／pins／authority identity／vault metadata／binding 的邊界變動均拒絕。

這是部分 erasure 投影，尚未清除原 reset 的完整 shout／trend 世代，也沒有證明最新來源 ancestry 或把第 142 號 derived source 接入完整 business／proof reconstruction。已有 source rebase 的候選在這一步拒絕，直到明確世代來源鏈完成。`globalResetGenerationsVerified=false`、`erasureOnly=true`、`recoveryRequired=true`、`releaseEligible=false` 及原 startup gates 維持。

## 驗證

新完整投影檔 **17 項**，含兩次真原 Python reset、empty-member reset、派生與無關曲目保全、loaded／persisted 不同、實際 key collision、缺 completion、來源邊界及六種完整 row corruption。較早 15 項版本已全部通過；完整相關五檔 **148／148 通過**，最後來源綁定版 **17／17 通過**；合計 **149 個不同案例**，零 failed／pending。strict、台帳及 diff 檢查通過。

首次 report **13／12／1 failed**，以及較早相關批 **72／71／1 failed** 原樣保留。兩份失敗均來自同一個測試以新程序嘗試第三次原 reset，被現有恢復保護拒絕；改為同一個原服務程序的第二次 reset 產生指定 key，沒有鬆綁保護或略過碰撞斷言。第 142 號 35 項原 fixture 的 defaults 保持。

本次完整 inventory 預期 **154 檔／2,475 unit**；browser **78 檔／833 項**。新提交全套 CI 需另核對，不能沿用舊提交結果。

第 141 號固定 browser artifact `14604963933` 原 ZIP SHA256 `a96e0eb2c4f8bbd964b0f7f64c2695939ab351337350503c11f1e22ada8f20b4` 已獨立核對完整 **78／833**，零 skip／retry／flake，全部原 ZIP／CRC／解包 bytes 保存。development Python report 另外核對 55 原 blobs、175 runtime inputs、原 dispatch／callback、三模式 counters／52 shells／bot 不重播；不宣稱線上 bot 版本或完整 B01–B15。完整 run 現已 terminal success；unit artifact `14606391148` ZIP SHA256 `0cd3b0c75bc93fea29021a703250ea510b3e74743fa58e61c6bd00491c08e9db`。完整 **152／2,423 unit** 與 **78／833 browser** inventory／identity／location／passed once 均獨立核對，零 skip／retry／flake，原 reports／ZIP／CRC／全部解包 bytes 保存。原 job logs 另行保存。

[第 142 號 run 44684536755](https://github.com/lyangjyehaur/jmusic-qgroup/actions/runs/44684536755) 綁定 `c3c0b102a66fa819c310b653497c4e52f0eb8357`，兩遠端 SHA 已相等，完整來源 archive、獨立 inventory 與固定 Python／bot harness 已保存。image job 已独立核對，web `sha256:3d3fdff6e9282b418512aec0ef8f2cd436b9dcbf98a9e43726b8a365641e6223`、Python `sha256:c747374c2af880b3b72014fca799fd792660a577de5cd809cd63bcf802b72756`；artifact `14605224418` ZIP SHA256 `e2f0a400d68126e2e3ca5aabf2e6704c6958a41e816109fb44d391cbafd1d2ce`，pair report `e20e31a9a48978ce8177caf6c3c3294d517eb7be51ccbc1f2fd66fb17398f9ae`。原 55 blobs／Dockerfile／websockets、三模式原 dispatcher／callback、85 HTTP／10 fixtures／52 shells、manifest／harness 與退出清理核對通過。unit／browser 尚待終態，結果不套用本次投影改動。

## 後續

166 項仍 `in_progress`，0 accepted，`release_eligible=false`。繼續完成全部 old／native reset 世代、generation business／proof／source rebase、外部 ancestry／custody／高水位、latest-erasure 私人歷史、media／browser pending、真正停止來源 capture、完整 TS bot／B01–B15／實際 QQ 與固定版本組合，以及 audited activation。仍不部署。
