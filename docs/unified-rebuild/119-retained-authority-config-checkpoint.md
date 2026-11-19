# 候選服務刪除保全配置檢查點

日期：2026-11-20。變更影響按 **`both`** 評估：正式 web 啟動、共用映像／Compose 配置及演練工具；實際發布範圍 **`none`**。沒有部署、合入 main、改動正式服務／bot／憑證／群設定或待送工作。實際固定版本組合仍待驗收。

## 啟動與配置

`retained-erasure-config.ts` 在開啟 service DB 前解析三個既有 `REBUILD_ERASURE_AUTHORITY_*` 配置。production 三值全缺時明確拒絕，不回退為未獨立保留的 local journal；任一缺漏／空值／錯格式在所有模式都拒絕。三值全缺的 development 仍允許隔離開發。`--version` 先完成 inert metadata 回報，不開啟資料庫或 authority。現有 journal config schema 的匯入位置保留 re-export。

候選 `unified-compose.yaml` 明確設定兩個服務 `NODE_ENV=production`，避免 private env file 改成 development 而繞過這個 gate。web 使用三個既有私人 bind source：

| 主機配置 | 容器入口 | 權限 |
| --- | --- | --- |
| `QGROUP_DATA_DIR` | `/var/lib/qgroup` | 讀寫；與 bot 共用業務 DB |
| `QGROUP_ERASURE_AUTHORITY_DIR` | `/var/lib/qgroup-erasure` | 讀寫；僅 web 掛載 |
| `QGROUP_ERASURE_CHECKPOINT_DIR` | `/var/lib/qgroup-checkpoint` | 唯讀；僅 web 掛載 |

`QGROUP_ERASURE_AUTHORITY_MANIFEST_SHA256` 必填，checkpoint 固定為 `/var/lib/qgroup-checkpoint/unified.sqlite3`。所有 bind 使用 `create_host_path: false`，不自動建立缺失 authority／checkpoint／data。這份檔案不建置、不自動發布。`check-runtime-compose.ts` 檢查精確 mount inventory、來源絕對且 canonical／彼此不重疊、checkpoint 唯讀、authority 可寫、禁止自動建立、production 與配置／pin 一致，保留獨立不可變 web／bot images、既有資源／rootfs／健康檢查。這是解析後宣告的驗證，不能取代主機 realpath／inode、所有權、外部 custody／retention 或實際 mount 驗收。

## 映像演練

Dockerfile 以原服務 UID／GID 建立三個 0700 空目錄，供新獨立 volume 的 service-owned fixture 使用；沒有在主機初始化正式 authority。`verify-image.mjs` 演練工具只使用新 volume 的全空私人根，由相同 runtime user 建立合成空 DB／authority。checkpoint 從 SQLite backup 生成，只有新副本轉成 DELETE journal mode、關閉後再讀 bytes／計算 pin；來源 DB 保持原模式。最初直接複製 WAL header 的 fixture 在 native memory reader 出現 SQLITE_CANTOPEN，保存為 `initial-wal-fixture/`，不作最後證據。

工具已接入三值及三個 volume，checkpoint 唯讀；待真正執行時驗證 Linux flock 排除另一進程、唯讀 checkpoint bytes、實際 mount RW、停止後釋放 authority lock 及原有 runtime／語言／bot synthetic health／資源檢查。空 fixture 的 sourcePackage pin 明確由 `synthetic-empty-image-fixture` 產生，不能作真實來源捕獲或 rollback package 的 provenance。沒有實際刪除業務資料、沒有啟動真正 QQ bot；本輪沒有執行該 Linux image 演練。

## 驗證與未完成項目

- 固定 973 份來源的相關配置／Compose／runtime／原生刪除 **72 項／5 檔全部通過**，零 failed／pending／todo；包含缺漏／空值／錯配置、真 production entrypoint 在 DB 開啟前拒絕、inert version，以及第 118 號 35 項刪除保全案例。
- 實際 Docker Compose CLI 的 `config --format json` 與同一 checker 通過，不連線 Docker engine 或啟動容器。三個新增必填主機配置逐一缺失時拒絕；合成 env file 的 development 被明確 production 覆蓋。宣告的 fixture image IDs 只是合成資料，不代表存在或已驗證的映像。
- 精確 image fixture body 已在本機執行；永久測試只換 module loading 為 TS source，保留實際 fixture 操作。獨立 protocol reader／memory checkpoint SQL 與 native retained factory（明確 Python test seam）接受新空 fixture，重跑在修改來源前拒絕。這不是 Linux image／實際 UID／mount 證據。
- 最新 strict TypeScript、完整建置、隔離 build smoke 已通過；重新產生 API bundle 與已建置 bytes 相同，174 份 project inputs 均對上來源 plan，沒有 migration／testsupport／test runtime。第 118 號固定來源完整 **1,828 項／135 檔**證據綁定提交 `b3bba88045ac558ce39c0382da09435ad0f36ac5`；本檢查點僅重新執行受影響組合，不宣稱已重跑目前來源全部測試。

私人證據：`/Users/danersaka/.codex/rebuild-verification/retained-config-119-9f7ea61bb9934ee19964d71e234ae80d/`，包括最終測試 JSON／log、`source-plan.json`／`final-summary.json`（來源 pin `5bc73b8fe9332519e50e38eda4c7c5fe1536f98be27bc69de9d25ad2d9dc5813`）、strict／build／smoke、實際 rendered Compose／required-setting receipts、精確空 fixture script SHA256 與獨立 reader 結果。

原 authority／回退產物仍 `rollbackEligible=false`，166 項能力仍 `in_progress`、`release_eligible=false`。舊服務回退後新增 board／music 刪除的完整 forward projection／rebase、任意較早 native baseline 的 footprint／恢復、原 raw journal 與捕獲來源的整合、外部 custody／retention／高水位、審計修復、structured reset term scopes、固定 Linux image／實際 web／bot 組合、browser pending／proof、B01–B15 完整候選與實機 QQ／規模／裝置均未因本配置 gate 而通過。按使用者要求不部署。
