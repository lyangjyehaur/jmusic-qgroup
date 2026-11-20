# 原始重置的磁碟與記憶體來源核對

日期：2026-11-20。發布範圍 **`none`**。離線遷移與恢復的相容性按 **`both`** 評估。沒有操作正式資料、憑證、群設定、待送工作或服務；不部署、不合入 main。

## 原始雙來源實作

原 Python reset 先用記憶體中的會員清除身分，再重新載入 persisted JSON 並清空 entries／members／shouts／shoutHistory／trend。兩份資料可能不同；會員 erasure suffix 只對應 loaded members，不能代表 persisted 的全部範圍。

新增 `verify_legacy_music_reset_sources`，要求原 persisted bytes 與 producer 用 Python 編碼的 loaded snapshot bytes 都存在。逐一核對完整 size／SHA256、loaded 的原 Python canonical encoding，以及兩套五容器 scope 的全部 map key／list index／row hash。保留原 source formatting、未知欄位、順序、浮點 exponent、`1.0` 與 `1`、負零等區別，不以 JavaScript JSON 重編碼替代原 producer bytes。驗證本身沒有檔案或 SQLite 操作。

TypeScript `verifyForwardLegacyResetSources` 接到完整、只讀的 authority reader。必須提供每一筆 structured reset 對應的兩份原始來源，依真實 authority sequence 排序；缺項、額外項、重複、錯序、任一 pin 或來源世代不符都拒絕。保留 authority manifest／checkpoint／head／record pins；以 held byte copies 與同步 boundary 在每個核對階段重查原輸入及 authority，不把重置後已清空的檔案當作原始 source。

Python 核對程序使用 `-I`，只從明確專案根載入 verifier，透過 stdin 接收 bytes；不啟動舊網站、bot、網路或資料庫。每份來源上限 64 MiB、全部來源上限 128 MiB，最多 1,000 筆 reset，單次程序 30 秒上限；stdout 只有 compact receipt，不輸出私人 source content。TS 另核對回傳 pins／size／五容器 counts 與原 authority 相等。

這是原始來源範圍驗證，尚未完成各次 reset 之間的 ancestry、後續寫入與 key reuse、完整業務三方合併、身分清除／重建或外部 custody。report 保持 `resetGenerationsReconciled=false`、`externalRetentionVerified=false`、`releaseEligible=false`，既有 projector／startup 的 structured reset gate 仍保留。實際正式舊服務尚未加上保存 loaded snapshots 的採集流程；缺少任一原始 snapshot 仍阻擋切換。

## 驗證

原 reset authority 完整檔 **40 項**、新增雙來源完整檔 **18 項**，共 **58 項通過**，零 failed／pending；strict 與台帳檢查通過。新增驗證包含兩次原 Python authority reset、空會員、不同 persisted／loaded entries 和 members、未知欄位／原 Python 數字編碼、缺失／額外／錯序／重複 source、兩份來源互換、獨立重新 pin 的替代內容、JS 重編碼，以及 late bytes／inventory／authority／非同步 boundary。

直接對原 Python verifier 的核對進一步確認：即使完整 source pins 正確，修改任何原 nested scope hash 仍拒絕；把 loaded 改為另一份自洽 hash 的漂亮排版 JSON 也拒絕。另一案例真的執行原 `service.administration.erase(reset=True)` 與 authority overlay，保存操作前兩份快照；核對通過後用實際已清空的檔案替換 persisted source，必須拒絕。原生 DB 與 pending／sending／sent／failed／skipped 的全部 bot rows 均維持原值。

新完整 unit inventory 預期 **151 檔／2,381 項**；browser 仍 78 檔／833 項。上述 focused 驗證沒有替代新固定來源完整 CI。

## 第 137 號完整回歸

[run 44672621057](https://github.com/lyangjyehaur/jmusic-qgroup/actions/runs/44672621057) 已 terminal **success**，固定來源 `41da48c9c2faf39c4c3f2d329f40fe651cb874c4`、tree `babc64f704523a6287d68b6d4c2afe847866c6fc`。3 個 jobs 成功。全部 **149 檔／2,339 unit**、**78 檔／833 browser** 的 assertion identity／location／inventory 與原完整預期相等，每項 passed once，零 incomplete／skip／retry／flake；原 ZIP、GitHub digest、CRC、所有解包 bytes 和完整原 logs 已保存與獨立核對。

unit artifact `14601217926` ZIP SHA256：`7ae6476ebe75ee76c283e9b3022d8a425f78d9a2e0066c70f750a80c001a4903`；browser artifact `14602027569`：`d5a338261f90f0aaf2c787a7a2748279cfac1e4126efc4f46fd523d91e33eb36`。固定 Python 與 compiled development web report 也逐項核對原 55 blobs、fixture／scenario、三模式所有 counters／原 dispatcher／callback、52 shells、原 receipts 與未重播 simulation／delivered rows。從該固定 Git archive 重新建置兩個 API bundles，175 個實際 inputs 逐一對照 Git blobs，bundle SHA 與報告相同；development 版本資訊保留 null commit／tree，不能當作實際映像的來源宣告。實際雙映像已有另一份獨立 receipt。

原第 136 號整體 failure 仍保留，沒有因修正後第 137 號成功而改寫歷史。第 137 號結果也不套用到後續新增 reset 修復。

## 第 138 號雙映像

[run 44675054259](https://github.com/lyangjyehaur/jmusic-qgroup/actions/runs/44675054259) 固定 `0f6dc8f1fc6ee9d79a33a9cedb08928bb665888f`、tree `52b8c7bb1b70655aaf3f4528b9b8e163314e68bc`。image job `136084799452` terminal success，完整原 report／inspect／55 Git blobs／固定 source-only archive 重新生成的 manifests 及所有情境已獨立核對。web image `sha256:e1af9c58a43bbce11f1a7bb4ac7b4c55ec6f30fa0a869ed13da939b3b69859e3`，固定 Python image `sha256:9e65744ba352660c488c25399b02fe60643004ffa94f11083a4316f02c835467`。

原 Dockerfile／實際 websockets 17.4、三模式原事件與 callback／投遞 counters、85 HTTP／10 fixtures／52 shells、兩容器退出與清理通過。image artifact `14602510911` ZIP SHA256：`a7e222d40ea13bef777ea3a29ab60844dd194e5c1de311931731be0476ec7354`；report SHA256 `0cc51f76bcb5125d1b638bda2cbfa1e44879e8589ea2aa2c36d5188b2f06b07c`。unit／browser 最新完整結果仍待終態。固定盤點 Python 不是已知目前線上 bot，仍不是實際 QQ 或完整 B01–B15 驗收。

## 剩餘門檻

166 項仍 `in_progress`，0 項 accepted，`release_eligible=false`。完整 music erasure／structured old reset／原生全域 reset 世代、外部 epoch ancestry／custody／高水位、私人歷史 latest-erasure、media／browser pending／proof、真正停止來源服務的 capture 演練、完整 B01–B15／實機 QQ／TS bot＋actual web image 與 audited activation 尚未完成。
