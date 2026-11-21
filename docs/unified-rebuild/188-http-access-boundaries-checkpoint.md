# HTTP 身份邊界與映像建置輸入

日期：2026-11-21。候選變更範圍：`both`（共用映像的建置輸入修正）；實際部署：`none`。未整合 main，保留 Python bot。

OpenAPI 初批加入 36 個人工核對的身份邊界，涵蓋 session／QQ／帳號切換、公開活動與名冊、成分保存、隱私收據、時間投票讀取、管理員登入／角色／備註／操作收據與註冊設定。描述逐項對應 handler 與中央 security／admin security，10 個來源檔以 SHA-256 固定；來源漂移、操作缺少或移動時生成器拒絕沿用舊 review。沒有從函式名稱推論完整授權，也沒有以 URL 前綴自動套登入規則。

契約區分匿名／visitor bootstrap、scoped device、scoped member、device／member write、帳號管理員與獨立救援憑證兩種授權，以及只使用 body proof 的註銷收據。寫入綁定相符 scope、精確 Origin、device CSRF；管理員寫入還要求當前 admin CSRF，管理員操作收據另外要求相符 admin scope。救援管理員仍可為 visitor，不因此取得 member 功能。活動匿名投影與時間投票必須具備裝置 scope 的差異保留；QQ bind 的 member 限制、privacy／provider／attempt 與管理員版本條件放在對應操作的描述內。

`boundaryReviewed=true` 只代表身份邊界描述已人工核對。其餘 158 個操作仍沒有此標記；全部操作的 domain authorization／完整權限驗收仍為 false，ownership、delegation、狀態與交易／receipt 驗收不能由此代替。現有 194 個操作的 body、query、response 及 296／127 個原 schema 全部相同，OpenAPI 423 個 component schemas 與 591 個本地參照保持有效。CI 現在額外保存生成的 `http-openapi.json`。

## 原 CI 失敗與修正

187 原 CI `44896999565`、提交 `6c57a11979b8326dd14dfa59b2e489b242e4665e` 的 image job `136824703772` 在建置步驟失敗：找不到 `/build/tools/rebuild/http-openapi`。加入生成器時漏補 Docker COPY 與 Dockerfile 專屬 allowlist，Linux container 未取得新建置模組；此原失敗保留，沒有取消或重跑 CI。該次 runtime、synthetic bot 與 Python image 配對步驟均 skipped，不記為通過。最後觀察時原 unit／browser 仍在執行；後續結果須另外核對原報告。

本輪補齊 OpenAPI／access 生成模組與兩個 JSON schema 的 COPY／allowlist。這是共用映像建置設定，因此保守按 `both` 記錄候選範圍；没有正式部署、重啟服務或改動 bot。188 新提交的實際 Linux image 驗證仍需 CI 確認，不以本機演練代替。

## 驗證

- strict 與完整建置通過。10 個相關 unit 檔案／102 個案例全部通過，包含 11 個新案例，與原固定 inventory 及獨立新案例 AST inventory 一致。全站 inventory 現為 189 檔／3,113 案例；本輪未執行全套 unit。
- 新案例包含 visitor／member 的實際 scope／Origin／CSRF 拒絕行為、救援憑證的 visitor 身份、admin CSRF 與到期重檢，以及隔離 API 的公開活動、visitor 投票、member 成分與 proof-only receipt。既有 QQ、管理員、隱私、時間投票與活動 access 測試通過。
- 獨立 Python jsonschema 驗證 OpenAPI；另核對 36／158 個邊界、九個 security schemes、管理員兩個替代方案、proof body、10 個人工 review 來源及 144 個契約輸入 hash。完整權限與發布資格維持 false。
- 本機 Docker daemon 未啟動，沒有聲稱 Linux image 通過。隔離演練依 Docker COPY 與專屬 allowlist 選出 391 個輸入，使用獨立 dependency 副本及指向 stage 內的 workspace links，完整建置成功。所有輸入與 243 個 runtime 檔案逐位元組核對一致。
- 本機 243 個 runtime 檔案與 187 全部相同，包括全部 3 個 API、9 個 bot 及 PWA metadata；應用程式、schema、outbox、設定與深連結未修改。本輪沒有重跑 browser／靜態 HTTP 檢查；187 的 PWA 3 案例、186／185 的原全站 browser 844 案例與靜態／precache 證據保持原紀錄，不改寫為本輪測試。

初始 strict 的 mock／cleanup 型別診斷，以及初次 27 案例中的一個 fixture 失敗保留：收據 fixture 使用了不符合既有 64-hex 格式的 secret，改正 fixture 後 102 案例通過，未放寬 schema 或修改斷言。初始 stage 模型誤帶被 Dockerignore 排除的測試，以及共用 dependency symlink 造成外部 workspace resolution 的診斷亦保留；最終 stage 使用正確 allowlist、獨立 dependency 副本，所有程式 bundle 相同。

證據：`http-access-boundaries-188/`，187 原 CI 失敗證據另存 `http-openapi-generation-187/`。受測來源 1,446 個 pins 在最終演練後固定，提交封存排除的測試後修改只限兩個 README 與本 checkpoint。166 capabilities 仍為 0 fully accepted，`releaseEligible=false`；精確路徑、其餘身份邊界、完整來源／reset／media、B01–B15、實際版本組合、切換及回退驗收仍待完成。未操作正式資料或真實 QQ。
