# 第八十三批實作：統一映像與明確服務啟動

日期：2026-11-18（Asia/Taipei）。分支 `codex/unified-rebuild`。變更範圍 **`both`**，實際發布範圍 **`none`**。只在本機 Unix Docker engine、合成資料庫、瀏覽器 context 與 mock QQ 驗證；未合入 main、未部署，未操作正式 bot、憑證、群設定或待送工作。

## 原生映像與來源

新增 `deploy/unified.Dockerfile`，以 Node 22.22.3 建置直接 React／TSX 前端、TypeScript API、bot 與資料庫工具。正式層只有建置產物、production dependencies 與來源資訊；不包含 Python 程式、Python interpreter、tsx 或 TypeScript compiler。原 Python Dockerfile／Compose 保留，尚未退役任何正式服務。

`tools/rebuild/prepare-image.ts` 要求乾淨工作目錄、完整 lowercase commit SHA 與全新的絕對輸出目錄；只 archive 指定提交，排除未提交檔案與本機依賴。來源 manifest 記錄 commit、tree 及 `rehearsal`／`origin-main`。`--purpose release` 必須先執行既有 Python 發布來源檢查；功能分支只能準備 rehearsal，不構成發布核准。工具不建置、不上傳、不部署。

本輪實際建置並驗證的來源為 `b7869c4d4625bc29e20995ac9882e6d7d91131d4`，tree 為 `62856fd4c76d471b60360847bc603c8a837d9747`，manifest source 為 **`rehearsal`**。在 OrbStack 本機 arm64 engine 建置及模擬運行 **linux/amd64**：

- 本機完整 image ID：`sha256:cec0664fba94e375e48c26f09dbceef0c8a8207ecc1ca2b6c43a13b443570ee5`。
- 建置時 Node base 解析為 `node:22.22.3-bookworm-slim@sha256:e21fc383b50d5347dc7a9f1cae45b8f4e2f0d39f7ade28e4eef7d2934522b752`。
- archive 輸出 `/tmp/qgroup-image-b7869c4d4625bc29e20995ac9882e6d7d91131d4/context`；Dockerfile-specific allowlist 傳送 4.08 MB。映像 revision label 與 baked manifest 在建置及運行驗證中一致。
- 此 image ID 是本機建置證據，未推送 registry，不是正式發布映像。後續只修改 host verifier 的 fixture 初始化及 runtime 斷言；映像內容仍是上述提交。

## 啟動、健康與代理

新增 `packages/runtime` 的 strict source schema。production 要求讀取 baked metadata，不能以環境 SHA 冒充來源；development 回報空 commit／tree。web／bot `--version` 在打開資料庫、讀取憑證或啟動工作前退出。

web production 要求明確 origin、絕對 DB 路徑及存在的靜態產物。`openServiceDatabase` 只打開已準備的目前 schema 與可用 storage lineage，拒絕不存在、舊 schema、legacy 或 recovery-blocked DB，不在正式服務啟動時悄悄建立或遷移。開發與離線 fixture 初始化仍用 `openDatabase`。

`/api/v2/version` 回報來源；`/api/v2/health` 與保留的 `/api/health` 實際執行 SQL，失敗回 503，不建立會員或 session。bot `--check-health` 只讀有界私有 health record，要求近期 poll、running／policy／gateway 與近期 ACK 或初始 READY；缺失或過期回失敗。健康不能取代功能驗收。

限流、PIN charge 與 request log 共用實際 client address：僅 loopback（含 mapped IPv4）可提供單一有效 `X-Real-IP`；外部 peer、forwarded chain 或不合法 header 不可偽造來源。保持既有 loopback proxy 語意。

## 各服務固定映像與隔離驗證

新增候選 `deploy/unified-compose.yaml`，web／bot 各自要求明確 immutable image reference、私有 env file 與共用絕對 data bind mount。沒有 `build`；保留 loopback proxy 所需 host network。服務以 UID／GID 994:992、唯讀 rootfs、ALL capabilities dropped、no new privileges、有界 noexec tmpfs 運行；各自限制 512 MiB、禁止額外 swap、1 CPU、128 PIDs。

`check-runtime-compose.ts` 只執行 Compose config 與限制檢查，不啟動服務。已用不同的合成 web／bot image IDs、空的臨時 env files 執行實際 `docker compose config` 並通過；工具兼容 Compose 輸出的數字及十進位字串記憶體值。版本組合、資料相容及來源仍須另行驗證，不宣稱完整自動發布保障。

`verify-image.mjs` 僅接受本機 Unix Docker engine 與完整 image ID／commit。使用自身新建 volume／container，**network none**、上述資源／權限限制；fixture DB 由服務使用者建立，所有 sidecars 同樣擁有權。驗證後已移除容器與 volume。實際通過：

- production API 啟動、健康與 baked 來源；React 路由及資產；better-sqlite3 與 sharp 原生執行；users 維持 0。
- UID 994／GID 992、rootfs 寫入拒絕、實際 memory／swap／CPU／PID／network／capabilities／privilege 設定；無 Python interpreter 或開發編譯器。
- bot baked version；缺 health、合成健康、過期 poll 三種 CLI 結果。此處沒有啟動 QQ Gateway，也不是 bot 平台驗收。
- SIGTERM 正常關閉、exit 0、未 OOM。

## 測試證據與剩餘工作

- strict TypeScript、React／API／bot build 通過；映像內 `npm ci`／嚴格建置／production prune 通過。現有大 bundle 提示仍在。
- **90 項不同原生測試**（13 files）通過：runtime metadata、明確啟動、來源 archive、Compose、SQL health、proxy／限流，以及既有 API／auth／registration／PIN／partner API 與 bot runtime／config／observability。
- **59 個不同瀏覽器場景**通過：auth、registration（含 activity-registration）、music recovery（含 durable recovery）及原財務請求恢復。
- 隔離本機 compiled build smoke 通過：API、bounded room worker、原生 bot HTTP／WebSocket／ACK／Resume／outbox／CLI／SIGTERM 及配對備份。這是獨立 mock 證據，不將容器的合成 bot health 記成真實 QQ 驗收。
- `git diff --check` 與能力台帳檢查通過。O14／O15 改為 `in_progress`；166 IDs 保留，**163 項 in_progress、3 項 planned、0 項完整驗收，release_eligible=false**。

仍需實際候選 web／bot 版本組合、完整 B01–B15、待送／重試／不確定投遞及切換所有權、來源資料對帳、遷移／回退、正式規模與實體裝置／QQ WebView 驗收。原請求 adapters、來源退休／目的版本查回及其餘台帳功能持續完成。候選 Compose 不取代目前正式 Compose，Python bot 必須保留到完整驗收。依使用者要求先不部署。
