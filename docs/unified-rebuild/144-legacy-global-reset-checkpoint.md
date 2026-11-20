# 原始全域重設的資料世代清除

日期：2026-11-20。發布範圍 **`none`**；恢復相容性按 **`both`** 評估。沒有部署、合入 main 或操作正式來源、bot 憑證、群設定及真實待送工作。

## 原生投影

原 Python `administration.erase(reset=True)` 在 loaded-member 刪除與 persisted reload 後清空整個 catalog／members／shouts／shoutHistory／trend。本次把原生候選的曲目、留言及趨勢清除擴展至原 checkpoint 的整個資料世代；重設前已在舊站刪掉的資料也不能從另一份原生映像中復活。loaded-member 的身份刪除仍使用原 suffix，不把 persisted-only 會員猜成個人刪除意圖。

原 checkpoint 中的曲目與引用、active／archived 留言、其私人 source shadows，以及 trend／trend_sample 原 documents 清除。原 migration mapping 維持原 revision／digest／target，狀態更新為 deleted；已是 erased 的留言映射保留其隱私原因。後續原生曲目、不同 ID 的 active／archived 留言、不同 source slot 與新增 trend samples 保留。

全部 reset 的原 vault／snapshot／completion 仍須完整核對。原服務後來新增的曲目或留言 key 若撞到無關原生 ID，停止候選；原 source slot 或 mapping revision／digest／target 已改變也拒絕。checkpoint 後又有 native reset、或候選已有 source rebase 時，要求明確世代來源鏈，不按同 ID／同內容猜測後續資料的身份。

writer 與獨立完整 row oracle 分別從原 checkpoint、已核對 vault 與實際 authority 推導範圍。核對 schema、pragmas、全部表／rowid／storage class、mapping 與 sqlite_sequence，保全 bot 五種状态、原 catalog／shout deletion／privacy receipts、活動及財務歷史。不啟動 worker，不新增管理請求或回執。結果仍 `erasureOnly=true`、`recoveryRequired=true`、`releaseEligible=false`；`checkpointGenerationCleared=true` 只證明本 checkpoint 的 catalog／shout／trend 投影，`allResetGenerationsReconciled=false` 保留。

第 143 號只移除實際 persisted entry scope 與 checkpoint 的交集。本次修正為原全域重設的 checkpoint 世代清除，避免重設前已移除的曲目被保留。所有原 captures／source bytes 都保留；不是把舊資料覆寫成新世代。

## 驗證

新檔 **18 項**：真原 reset 五容器、重設前真正修改 persisted 來源、匿名歷史留言、後續原生兩類留言／source shadow／trend 保全、實際 ID collision、revision／digest／target／shadow 改變、真正 native reset 的新世代拒絕、八種獨立 row corruption，以及原 Python 直接讀取來源與候選 SQLite、bot／歷史與 recovery flag 核對。

完整新 global 檔 18、原 projection 17、generation 35，共 **70／70 通過**，零 failed／pending；strict、台帳及 diff 檢查通過。完整刪除／reset 六檔 **167／167 通過**，零 failed／pending，原 raw report 保存。新完整 inventory 預期 **155 檔／2,493 unit**，browser **78 檔／833 項**。

最初 existing report **17／14／3 failed**、global report **18／6／12 failed** 與原 strict 診斷保留；失敗來自未結束的 SQLite iterator 內更新同 connection，已改為先物化映射列，再在同一交易更新。另修正測試原 admin profile 的 userId 與 TypeScript control-flow narrowing，沒有略過任何資料／bot 保全斷言。

## 固定 Linux 來源

[第 143 號 run 44686125294](https://github.com/lyangjyehaur/jmusic-qgroup/actions/runs/44686125294) 的 image job 已成功並獨立核對，固定 `55516baa08cf707a168fb8c65c78c9f3e857cf8d`／tree `0a03ea0787374b84a1b92d59138b5b3d0084ae35`。web `sha256:2c4a86cfe0ff722af2e7a4c78f2df81e5d4617356d5eac3aec4672da4bf4cf19`、Python `sha256:022ff6a311c1763ffabf0a098aea3b1068100794cc4fa3c44b9335a5da02816d`；artifact `14606088596` ZIP SHA256 `e496924579e4514bfcfa8d8ec6244ee93af20b7c46bf234b94ea7d19417af622`，pair report `c0b13045dde911577441398a9882d71e5fb01f9298a161bbd93d978a19d7002c`。55 原 Git blobs／Dockerfile／websockets、重新生成 manifest／harness、三模式 counters／原 dispatcher／callback、85 HTTP／10 fixtures／52 shells、原 ZIP CRC／全部解包 bytes 與退出清理核對通過。

第 142 號 run 44684536755 已 terminal success；完整 **153／2,458 unit**、**78／833 browser** inventory／identity／location／passed once 均獨立核對，零 skip／retry／flake。unit artifact `14607762082` ZIP SHA256 `ebf9a11d05542309f67ef0086d61caab5d877bfc84c505a3337f2f3ff2d1b354`；browser `14607950197`：`cb8b5706024bfe14d3f5fdd2e2768027a927da246b555df87d120883834bf2c4`。原 reports／ZIP／CRC／全部解包 bytes、完整 receipt 与 development Python 的原 55 blobs／175 runtime inputs／三模式 dispatch／callback／counters 已保存並核對；本次 global 修改另驗收。第 143 號 unit／browser 仍待終態。本地 development Python、固定驗證 Python 與合成平台均不能代替目前線上 bot 身份或完整 B01–B15／實際 QQ 驗收。

## 剩餘

166 項保持 `in_progress`、0 accepted、`release_eligible=false`。完整 latest generation 的業務／proof reconstruction／source rebase、loaded／persisted 會員與身份的世代差異、native global reset 後續世代、外部 ancestry／custody／高水位、私人歷史 latest-erasure、media／browser pending、真正停止來源 capture、完整 TS bot／B01–B15／實際 QQ／固定版本組合及 audited activation 仍需完成；不部署。
