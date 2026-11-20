# 靜態資源壓縮與快取驗證

日期：2026-11-20。變更範圍：`web`；新增建置壓縮與原生靜態服務政策，schema、outbox、bot 設定及網站入口不變。本批沒有部署。

Vite 在輸出 JS／CSS 等文字資源後產生 Brotli 與 gzip sidecar；只處理至少 1 KiB、壓縮後節省超過 64 bytes 的資源，原檔 bytes 與 URL 保留。Fastify 依 `Accept-Encoding` 選用表示、保留 logical MIME 與 `Vary`，不同表示使用各自 ETag。帶內容 hash 的 `assets/` 資源為一年 immutable；固定名稱資源重新驗證，SW／manifest 為 `no-store`。翻譯 shell 維持 `Vary: Accept-Language`／`no-store`，API 與 session 維持 Cookie variation／`no-store`。sidecar 不能作為直接網站入口。

本機 **1 檔／19 個不同案例**通過：Brotli／gzip roundtrip、原 bytes、品質與排除協商、JS／CSS MIME、安全 headers、同表示 304、跨表示 200、GET／HEAD、identity range、真正有壓縮 siblings 的 SW／manifest、固定 icons、翻譯 shell／bot 深連結、實際 session 回應與 Cookie、直接 sidecar／不存在資源拒絕。strict、完整建置、built smoke 與功能台帳通過；不新增介面文案。

新增 `verifyBuiltStatic`，在本機 compiled API 及 Linux image verifier 使用同一组真實 HTTP 檢查，逐一與各環境的建置檔比較。此次本機有 **3 個 JS／CSS 資源、40 次 HTTP 檢查**，涵蓋全部表示原 bytes、6 次 conditional、6 次 HEAD、6 個 sidecar 直接 URL 拒絕，以及 SW／manifest／shell。主 JS：1,483,325 bytes → Brotli 359,218／gzip 430,114；CSS：123,352 → Brotli 16,940／gzip 18,709。這是傳輸 bytes，不能當成記憶體、解析、互動時間或正式負載驗收；主 JS 仍需改善載入分割。

compiled API 與固定原 Python bot 的 plain／rich／dry-run 隔離驗證通過，52 個既有深連結仍可取得 shell；没有真實 QQ 投遞或正式服務操作。重新以 esbuild 收集並獨立建置兩個 API bundles，**177 個 runtime inputs**與本機產物對上；原先為 176，新增 `static-cache.ts`，不能沿用舊 runtime pins。

第 151 號 CI run `44749557550` 已完整 success：原 ZIP metadata digest／size、CRC、所有 extracted bytes、固定 unit 164／2,643 與 browser 78／833 inventory、三份原 job logs、原 image pair 及 compiled development Python 皆獨立核對；沒有 skip／retry／flake。第 152 號 run `44755576359` 的 image pair 已核對，unit／browser 尚在執行；本批全量來源預期 **167 檔／2,676 unit、78 檔／833 browser**，仍須取得原 CI artifacts 核對，不用本機結果替代。

O11 保持 `in_progress`。本批尚未完成新原 Linux image／browser 的完整驗證、代理層快取與正式規模資源驗收。其餘來源鏈、歷史／待送恢復、完整 bot 候選版本組合及切換驗收持續待辦；166 capabilities、0 accepted、`release_eligible=false`。保留 Python bot，不合入 `main`、不部署。
