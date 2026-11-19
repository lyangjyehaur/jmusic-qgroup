# 原生刪除紀錄續寫與啟動恢復檢查點

日期：2026-11-20。變更影響先按 **`both`** 規劃與驗證；本輪實際發布範圍 **`none`**。新增 TypeScript 網站的明確 authority 配置、journal writer／read guard／啟動恢復，並搬移共用原格式 codec／私人來源讀取 helper、修正共同映像的建置來源與 Linux flock 依賴。沒有修改 schema、outbox 格式、正式 web／music／bot、憑證、群設定或真實待送工作；未合入 main 或部署。實際候選 web／bot 組合仍須成套驗收，這不是單邊發布核准。

## 原生續寫與原 bytes

`retained-erasure-journal.ts` 使用第 117 號的同一份三 domain authority，在 native website 生命週期持有 OS flock 排除舊 overlay／離線 authority writer；只追加 unified domain，保留原 board／music baseline 和完整 chain。bot owner、工作及投遞者不由此工具啟動或變更。停止 native website 後，原 Python authority 可以接續操作；要讓舊 web／music 使用新的 native intent，仍須通過回退投影與完整版本組合驗收，不能直接讓它們並行寫入。若舊服務在回退後新增 board／music domain intent，native 啟動與讀取會核對最新 ledger 是否仍等於 immutable baseline，發現新增內容便拒絕；完整向新版投影／rebase 尚未實作，不會以 unified-only replay 假裝已套用這些刪除。

native writer 先 exclusive 新建並 fsync immutable record／records 目錄，再 atomic replace 並 fsync head，最後追加／fsync 本地 journal／父目錄。record_fsynced／head_published／before_source／source_fsynced 之間的真程序中斷可以在重啟後補完。僅最後一筆完整且尚未發布的紀錄可驗證後補 head；半筆／遺失／衝突／未知 inventory 或遺留 head temporary file 阻擋啟動，不丟棄來源或自動修復。最後 temporary fsync 後再次核對原 head inode／bytes、所有 baseline／record 與目錄，只有本次精確 temporary 名稱可額外存在。完整錯誤修復仍須審計工具。

source journal 只可從 authority 的 exact byte prefix 補回，包括缺失、baseline、半行及截斷。journal.read／assertReadable 重新核對全部 source／authority bytes 和目前 lineage；API privacy.guard／partner assertReadable 接入這個檢查，因此本地 ledger 倒退、遺失或外來內容會以短 503 阻止讀取、匯出及業務操作。native write 失敗後保持 fail closed 到重啟驗證，同生命週期已觀察的 record pins 不允許倒退或更換。

## checkpoint 與原格式準備

authority manifest 綁定的 checkpoint SHA256 必須與另外保留的完整 source checkpoint bytes 一致。啟動只在 disposable memory DB 讀取該 immutable checkpoint 的 schema／lineage／recovery marker，不開啟其來源 DB 路徑；目前 service DB 必須是同 lineage 且不需要 recovery review。一般後續業務寫入不要求回到原 DB digest。checkpoint 在啟動時驗證，原 copy 不被替換或遷移；完整業務資料對帳仍是獨立門檻。

原 admin API 的 journal 把 createdAt 放在 proof 欄位之後，而回退投影按 schema 順序序列化。兩份意圖相同但原 bytes 不同，不能把這當成 foreign journal，也不能在原 runtime 啟動時偷偷重排檔案。本次準備工具增加明確的 native DB／外部原 journal digest：先驗證原 bytes／strict JSON／完整逐筆意圖等於 pinned checkpoint journal，再把**原 bytes**作 unified authority baseline。其他兩個 domain 維持原投影。只讀取 native ledger，DB／sidecar 只作 lstat inode 排除；來源變更、錯 pin、未記錄 intent 或輸出重疊均拒絕。未提供 native source 的既有 3 參數命令保留第 117 號行為，供舊服務投影演練使用。

```sh
npm run prepare:rollback-erasure-authority -- \
  <私人回退套件絕對路徑> <外部套件-manifest-SHA256> \
  <全新私人-authority-絕對路徑> \
  <來源-native-DB-絕對路徑> <外部原-native-journal-SHA256>
```

原 native journal 的 digest 必須由同一來源捕獲／審閱流程提供；不能把這份新 authority 反當成來源 journal 的 provenance。準備只寫新私人 authority，不改原 journal／DB，不啟動服務。source checkpoint 是完整套件內的 `private/latest/unified.sqlite3`，其 bytes 已由 authority manifest checkpoint pin 綁定。

## 明確啟動配置與鎖

native `start.ts` 同時設定以下三值時才使用 retained journal；任一缺失／空值／錯格式均阻擋，不降級成未保全的 journal：

- `REBUILD_ERASURE_AUTHORITY_ROOT`：單獨保留的私人 authority 絕對路徑。
- `REBUILD_ERASURE_AUTHORITY_MANIFEST_SHA256`：外部保存的 immutable authority manifest pin。
- `REBUILD_ERASURE_AUTHORITY_CHECKPOINT`：另外保留的原完整 checkpoint 絕對路徑。

已建置 entrypoint 的五種缺漏／空值／錯格式配置均在 DB 開啟前拒絕，隔離目錄未生成 DB／sidecar；相同錯配置下 `--version` 仍為 inert metadata，證據為 `startup-config-rejections.json`。三值都未設定時保留目前 local journal 路徑，供既有隔離開發和過渡使用。**正式候選必須明確接入 retained 配置，現有 Compose 尚未新增 mount／強制配置 gate；不能因這份文件便宣稱所有正式啟動已受保護。** 外部 custody／retention 與部署協調仍須提供 authority／checkpoint 的獨立保存及 restore 排除範圍。

Linux runtime 使用 `/usr/bin/flock` 的 FD form，只有 descriptor 參數，不以檔名重開鎖；bounded child call 鎖定 inherited FD 3，native parent／Node holder 持有相同 open description。helper 退出但 parent FD 尚在時，實際 flock 排除持續；holder 失效仍使 journal guard 拒絕。關閉時退出 holder 再關 parent FD，啟動／配置／createApp 失敗會關閉 DB 與 authority。非 Linux 的正式 helper 明確拒絕。本機測試用明確選定的 Python flock holder，這是 test seam，不是 production Python runtime。

既有 SQLite／WAL／SHM／journal inode 用 lstat 持續觀察並保留，authority／source／checkpoint alias 在 raw FD 開啟前拒絕，避免 close 額外 raw FD 釋放 SQLite POSIX writer lock。只有私人 regular files 可作 ledger／lock；不 chmod 或重新建造缺失 authority。整份 authority／head 同時倒退仍無法僅 baseline pin 判斷，外部最新高水位與保留認證門檻未取消。

## 實作與驗證

共用 protocol 移至 native API 的 `erasure-authority-protocol.ts`；immutable reader 的預設仍只接受完整 publication，native recovery 必須明確要求 includeUnpublished 並持有排除後才可發布。strict JSON 與 private source readers 移到純 TS runtime modules，舊 migration import 路徑保留 re-export。native API bundle 不載入舊 Python service、rollback package CLI 或準備流程。原生歷史與匯出曾直接引用 migration music codec，Docker context 又不包含該目錄；本次將 codec／identity source／frozen schema 移到 `packages/database/src/legacy-*`，兩個原生 consumer 改用共用 module，migration 路徑保留 re-export。Docker ignore 補入既有 COPY／RUN 所需的 `build-error-displays.ts`；runtime stage 明確安裝 util-linux 提供 `/usr/bin/flock`。

新增 35 項案例納入固定來源完整回歸：member music／account／both；真 native API 刪除、admin delete／reset 的 reviewed IDs 與原回執重試／歷史匯出；真 Node exit 77 四階段後重啟恢復；missing／baseline／partial journal 加同 baseline DB 恢復後重播兩次（不代表任意早於 baseline 的 DB 已驗收）；原 Python chain 互讀／接續；全生命週期 writer 排除與 holder 被 kill 後 parent FD 仍持鎖；wrong checkpoint／其他真正新建 lineage／原 SQLite alias；原 head 同 bytes 但 inode 被更換、temporary 保全、同生命週期高水位、async hook、private source 與原 native admin byte formatting／CLI late changes；實際舊 board／music writer 新增 intent 後阻擋 native；真 SQL receipt trigger 中斷後保全 intent、修復再重播及精確重試只追加一次。

SQLite alias 案例在 native DB 持有 BEGIN IMMEDIATE，ledger 路徑改成其 DB inode後 raw guard 拒絕，另一 Python writer 仍被排除。全部五種 bot 狀態、claim／retry／simulation／已送本文與原套件 bytes 保留；沒有啟動真 worker 或真實 QQ 投遞。

最新來源的 Strict TypeScript、完整 build 及 build smoke 已通過；build smoke 是空隔離 DB 和本機合成 HTTP／WebSocket，覆蓋 API、native worker、ACK／Resume／ownership／未知投遞與備份匯出，**未接入 retained 配置的 Linux image 組合**。本機 Docker daemon 未運行，Linux `/usr/bin/flock`／固定映像／runtime user／mount／resource 組合本輪尚未取得執行證據，不能把 Python holder 的本機證據寫成 Linux 映像驗收。

另在全新私人目錄只複製 Docker 允許的 371 份生產來源，排除 migration／testsupport／tests，以相同建置命令完成 strict／Vite／全部 runtime bundles。第三方 node_modules 重用本機安裝，所有 `@qgroup` workspace links 改指向副本。對 12 個 API／worker／bot bundle 的全部 project inputs 逐一核對 realpath 與原 SHA256：均在副本內，沒有回讀原 workspace 或 migration 工具。這是生產來源 context 的本機建置證據，沒有執行 Docker npm ci／prune 或 Linux image。證據在 `production-context-inputs.json`、`production-context-build.log`、`production-context-bundle-inspection.json`。

私人紀錄根：`/Users/danersaka/.codex/rebuild-verification/native-erasure-118-90ef34903ab041008f18c25cc5ba2856/`。完整回歸使用固定 135 檔與 15 個單工批次，`regression-plan.json` SHA256 為 `6d0400d7b7b80348f096653d40f0720b4e1952f73aa8eb8b155f5ce37607e621`；逐批 log／JSON 及 final-summary 保存最終核對。來源修改期間的兩份過時回歸保存於 `earlier-source-plan/` 與 `obsolete-before-codec-context-fix/`，不當成最後證據；沒有把 filter test 的 skipped 當成完整通過。最後 `final-summary.json` 獨立核對 **1,828 項／135 檔全部通過**、15 個批次均成功、零 pending／todo／failed，971 份來源 inventory／bytes 未改變，每個檔案與 assertion 都有唯一且完整結果。最新 `build-current.log` 與 `build-smoke-current.log` 保存建置／隔離啟動證據。

仍缺 Linux 固定 image／配置／checkpoint／authority mounts 成套驗收、來源捕獲原 raw journal 與外部 pin 的部署整合、強制候選配置 gate、外部 custody／retention／高水位、audit repair、舊 reset term scope、回退後新增 board／music intents 的完整 forward projection／rebase、任意早於 native baseline 的恢復／footprint、完整舊服務／forward restore、browser pending／proof、候選 B01–B15、正式規模／效能／裝置與真 QQ。全部 authority／回退產物仍 **rollbackEligible=false**；台帳維持 **166 in_progress／0 完整驗收、release_eligible=false**。按使用者要求不部署。
