# 第八十五批實作：統一頁面與互動統計

日期：2026-11-18（Asia/Taipei）。分支 `codex/unified-rebuild`。變更範圍 **`web`**，實際發布範圍 **`none`**。只使用本機合成資料庫、隔離 Chrome context、攔截的統計傳輸與本機 Docker，未合入 main、未部署，未改動正式 bot、憑證、群設定或真實待送工作。

## 統計與原文邊界

沿用公開 Umami website ID `5244d326-3db9-4499-9c7a-6e3568b296cd` 與 `https://u.danndann.cn`；前端只在完整 origin `https://kanban.danndann.cn` 啟動。API 的 CSP 依設定 origin 決定，請求 Host 不得開啟統計。腳本非同步且關閉自動追蹤、頁面、效能、query／hash，credentials 為 omit；沒有 identify 或帳號關聯。

建置以 TypeScript AST 收集目前路由、API 路徑及靜態 JSX id／name 宣告；不收集 live DOM 的任意標识。靜態入口優先於參數入口，避免新增活動頁被當成活動詳情。傳輸另行重建白名單 payload，覆蓋原 URL、標題、referrer 及 tracker defaults；參數統一為 `:id`，未知入口／操作回固定值。

保留點擊、提交嘗試、debounced 輸入、選擇／勾選、驗證失敗、展開收合及 dialog 狀態／取消。共用 API client 只記寫入成功、拒絕、網路及解析失敗；GET／刷新不記互動。傳輸僅有固定頁面／控制項／context、語言、螢幕尺寸、勾選狀態、操作類型、HTTP 方法／狀態與固定結果；沒有姓名、金額、ID、token、欄位值、顯示文字、href、原始錯誤或 request body。密碼及 hidden 欄位不記編輯／驗證。此統計不改動操作本身的錯誤、輸入或重試語意。

待送最多 100 筆，等待 tracker 最多 30 次；cleanup 移除 listener／observer／timer 及待送資料。tracker 被封鎖、throw、非同步拒絕或腳本插入失敗均不阻擋網站。這是選用統計，不是投遞保證；網路服務仍可接觸必要的 IP 等請求資訊。

## 隔離驗證

- strict TypeScript、React／API／bot build 與 compiled smoke 通過，既有大 bundle 提示仍在。
- **64 項不同原生測試**（9 files）通過：6 項 manifest／payload／origin 測試、runtime 及既有 auth／account profile／registration／activity registration／auth-bot／activity-bot／bot runtime。
- **46 個不同瀏覽器場景**通過：12 項統計場景，以及 auth、account-profile、activity-sharing、legacy-navigation 回歸。包含 field 值／password／hidden 不外送、驗證／勾選／dialog、100 筆 buffer、blocked／throw／插入失敗、真實共用 client 的 success／rejected／parse／network 結果及 bot 舊入口不自動寫入。
- 使用唯讀下載的既有公開客戶端（4,655 bytes，SHA-256 `1ad1145d19d4558c20f5469ca4a5fc50a1a46f860858c9c91bfcd56fd29a522a`）驗證真實載荷：頁面轉送到本機 fixture、統計 `/api/send` 全部攔截，其他 origin 阻擋；沒有向正式網站或統計服務送出事件。客戶端版本日後更新須重新驗證。
- 首輪腳本插入失敗場景在 DOM head 尚未建立時安裝 mock，未實際阻擋；改為在 Element prototype 安裝後全套通過。delayed tracker 用 finally 釋放 gate。未跳過測試或改寬傳輸限制。
- compiled smoke 包含原生 bot mock HTTP／WebSocket、ACK／Resume、未知投遞／模擬／CLI／SIGTERM 及配對備份。未改 bot 指令、模板、schema、outbox 或深連結；未宣稱 QQ 平台驗收或線上版本組合相容已完成。

## 固定來源映像

來源提交 `149497084438c2ad2680471105af1fe6ce5bf8a1`，tree `f6c588aa10b15c0cba81390fcf55c195ad93a5a5`。乾淨工作目錄經 prepare-image 的 rehearsal archive 產生 `/tmp/qgroup-image-149497084438c2ad2680471105af1fe6ce5bf8a1/context`；未覆蓋未提交程式。Dockerfile allowlist 已納入 manifest generator。

本機 OrbStack arm64 engine 建置／模擬 linux/amd64，image ID **`sha256:cad79d65ad62d1251192f0eb633f6a1d0cee2cc607ff75af2d657f6b082568ce`**。Node base 解析為 `node:22.22.3-bookworm-slim@sha256:e21fc383b50d5347dc7a9f1cae45b8f4e2f0d39f7ade28e4eef7d2934522b752`。`verify-image.mjs` 通過 production API／source、React／SQLite／sharp、zero users、UID/GID 994:992、readonly／caps／no-new-privileges／network none、512 MiB／無額外 swap／1 CPU／128 PIDs 與 SIGTERM exit 0；bot 是版本與合成健康檢查。自身容器及 volume 已清理，映像未推 registry。首個 Docker 指令用了錯誤的相對 Dockerfile 路徑，修正後只用同一 archive 建置，未修改來源。

此映像包含活動摘要與本批統計，**不包含後續簡繁修改**。O10 改為 `in_progress`：166 IDs 保留，**165 項 in_progress、1 項 planned（O08）、0 項完整驗收，release_eligible=false**。全站簡繁、統一手冊、來源資料對帳／遷移／回退、完整 bot B01–B15 與實際候選版本組合、效能及實體裝置／QQ WebView 驗收持續進行，依使用者要求先不部署。
