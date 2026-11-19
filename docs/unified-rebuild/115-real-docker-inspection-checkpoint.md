# 實際 Docker 擷取證據檢查點

日期：2026-11-19。發布範圍 **`none`**：修正離線擷取工具，新增明確執行的本機容器演練；沒有修改 web／bot 運行程式、正式資料、憑證、群設定或真實待送工作。未整合 main、部署或完成全部功能驗收。

## 真實 Docker 與工具修正

檢查點 112 的 Docker 測試使用假 executable 與合成 response。本輪在 canonical 本機 Unix socket 執行實際 Docker 29.8.2 client／server，補上真正 Go-template、container metadata 與預設 CLI 擷取的證據。

先用三個不啟動的 scratch 容器確認：固定 `node .rebuild-dist/api/start.mjs`、`node .rebuild-dist/bot/start.mjs`、`python3 -m qgroup_bot.main` predicates 均正確；缺失 revision label 真正回傳 `null`。沒有將未證實的模板猜測改成程式。

擴大演練後，原 `inspectCaptureContainer` 的環境值解析確實失敗：`KANBAN_DB=/data/unified=fixture.sqlite3` 被截成 `/data/unified`。現在使用完整剩餘片段重新連接，保留 `KANBAN_DB`、`JPM_DATA`、`KANBAN_BOT_LOG_DIR` 中的全部 `=`。仍只讀必要設定，不讀完整環境或 QQ 憑證。

原擷取工具同時補上：

- 明確 socket 必須 canonical，拒絕 symlink、相對路徑及遠端 endpoint；省略時僅解析 `/var/run/docker.sock` 的本機 canonical 目標。
- standalone inspection 前後核對 socket device／inode／型別與返回的完整 container ID。
- 完整原系統 acquisition 持有同一 socket 身份，跨所有分開的 inspections 核對；同型 socket 在兩次命令之間被換掉也拒絕。
- Docker 子程序清除 endpoint／context／TLS 與 NODE_OPTIONS overrides；來源檔案、SQLite、flock 和其他擷取規則不變。

這些是身份 fence，不是部署鎖、daemon 控制權或完整停寫證明。來源版本、有效配置及跨主機協調仍未完成。

## 可重跑的 create-only 演練

新增 `tools/rebuild/verify-rollback-inspection.ts`：

```sh
npm run verify:rollback-inspection -- \
  --socket <canonical-local-docker-socket> \
  --image <完整且已存在的-image-ID> \
  --commit <完整-source-SHA>
```

工具不拉取或推送映像。先窄讀指定映像的 ID、revision、architecture 與有無 implicit volumes；拒絕會自動建立 volume 的映像。固定已有映像用於觀察宣告的原生指令；另在 0700 私人 context 以無 RUN／COPY 的 scratch Dockerfile 建立唯一標籤的合成 metadata image，不包含專案原始碼、runtime、憑證或資料。

所有容器只有 `docker create`，不使用 start／run／exec／stop，不執行任何容器內程式。每個容器有唯一名稱、label、cidfile；實際核對 network none、readonly rootfs、64 MiB memory／同額 swap 上限、1 CPU、16 PIDs、ALL capabilities dropped、no-new-privileges。這裡只證明 inert fixture 的 metadata 限制，不重新宣稱運行中服務的 RSS、CPU、平台或功能驗收。

只清理本輪保存的完整 ID，逐一核對原名稱／label／created state，`docker rm` 不使用 force。只移除本輪 scratch image tag；指定已有映像保持原樣。清理失敗不輸出成功結果，保留私人 fixture；不列舉、停止、移除任何既有容器，也沒有建立 volume。正常完成後本輪 17 個容器、scratch image tag 和私人 fixture 均已清理。

本輪已有映像：

- image ID：`sha256:cec0664fba94e375e48c26f09dbceef0c8a8207ecc1ca2b6c43a13b443570ee5`。
- revision：`b7869c4d4625bc29e20995ac9882e6d7d91131d4`。
- 来源是[檢查點 89](89-unified-runtime-checkpoint.md)的本機 amd64 rehearsal；沒有重建、發布或宣稱它是目前完整候選版本。

## 驗證範圍

真 Docker **23 項檢查／17 個 inert 容器**通過：

- 三種 runtime predicates、指定映像預設 web command、原生 bot command、已知 Node entrypoint；extra argument、shell wrapper、外部 entrypoint／working directory 拒絕。
- label 缺失、空字串及錯誤 revision 明確區分；缺失 Python revision 只在提供 external commit-record reference 後通過 boundary schema。沒有讀取、核准或認證該外部 record／commit。
- development、NODE_OPTIONS、missing role 的 CLI 拒絕；空 NODE_OPTIONS 可用。帶敵對 inherited Docker endpoint／context／TLS 的子 CLI 仍只能使用明確本機 socket。
- 兩種 inspector 保全包含 `=` 的環境值；相似前綴與未選取的合成 secret 不進 evidence。bot env-file override 維持缺有效配置證據而拒絕。
- 真 Docker parent bind 與精確 file shadow mount；最深層 shadow 不會被忽略，錯誤 DB source 拒絕。
- 不使用 injected inspector 的預設 `captureRollbackPackage`：實際 Docker web＋TS bot metadata 封存完整 v3，再由固定 reader 對帳。原 raw journal、來源 DB、全部 outbox pending／sending／sent／failed／skipped、claim／retry／simulation／frozen body 保持；封存後兩個容器 evidence 相同。
- 上述持鎖擷取的五個 guard 中，真 Python SQLite 程序分別競爭業務庫與 bot owner，共十次均被排除。沒有原 inode 的額外原始 FD 讀取或容器執行。
- 實際 Docker web＋無 label 的 Python-command metadata 另封存 v3，固定 reader 保留 null 與 external reference。scratch 容器沒有可執行的 Python bot，**不是舊 bot 運行或版本相容驗收**。

CLI 成功結果只包含 pins、數量、固定 check names 與 false eligibility；失敗不回顯底層 stderr、私人路徑或原設定。兩份實際 v3 套件仍為 `rollbackEligible:false`，外部 deployment／retention 協調和 actual candidate gates 不變。

## 回歸與剩餘工作

相關 **103 項／2 檔通過**，新增四項 socket／返回 ID／子程序設定測試；Strict TypeScript 通過。完整單工回歸 **1,649 項／132 檔通過**；能力台帳及 `git diff --check` 通過。回歸中的 release-source 拒絕文字來自预期拒絕的隔離測試，不是發布操作。

紀錄：`/tmp/qgroup-inert-inspection-final.log`、`/tmp/qgroup-inert-inspection-targeted-final.log`、`/tmp/qgroup-inert-inspection-typecheck-final.log`、`/tmp/qgroup-inert-inspection-native-final.log`。初次真實測試證明原環境值截斷後已修正，原始失敗紀錄為 `/tmp/qgroup-inert-inspection-initial.log`。

仍缺外部部署／retention 及完整停寫邊界、有效 bot override／配置與版本認證、固定舊 history overlay 的 image／gateway／browser／durable erasure 權威、歷史看板 latest-erasure 恢復、固定舊 web／music／bot 全套讀寫與 forward restore、browser pending／proof、B01–B15 完整候選組合、正式規模／效能／bundle／實體装置與實際 QQ。台帳維持 **166 in_progress／0 完整驗收，release_eligible=false**。依使用者要求不部署。
