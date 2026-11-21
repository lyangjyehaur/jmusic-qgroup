# 候選 web／bot 版本清單核對

日期：2026-11-21。候選設定影響範圍：`both`；本輪發布範圍：`none`。不合入 `main`、不部署、不操作正式資料或 QQ。

`check-runtime-manifest.ts` 新增離線版本清單校驗。分別核對 web／bot 的不可變映像引用、實際 image inspect ID／RepoDigest、revision label、平台、服務回報的 TypeScript runtime／commit／tree／source，以及解析後的 Compose 設定。允許兩個服務使用不同提交與映像；同一提交不能宣稱不同 tree，同一映像 ID 不能宣稱不同來源。

候選 Compose 明確把 `QGROUP_ORIGIN` 指定給 bot 的 `KANBAN_BOT_BASE_URL`。web／bot 必須共用同一 canonical HTTPS origin 或隔離 loopback HTTP origin；缺失、不同網址、路徑、query、credentials、非 loopback HTTP 都拒絕。獨立保留的 erasure authority manifest pin 也與清單核對。原正式 Compose、Python bot、共用 schema／outbox 和業務程式未修改。

`verify-image.mjs` 保存原本已取得的 web HTTP version 與 bot `--version` 完整回報。新 CI 步驟以該原始報告、image inspect、明確提交封存的 build source 建立演練清單，執行相同校驗器並保存輸入 hashes。校驗工具 bytes 必須等於封存來源。Compose 只解析新建私有目錄、空環境檔與顯式變數，不讀正式配置、不啟動服務，也不驗證這些空目錄的 authority 內容。

清單及 CLI 檢查有明確邊界：版本資料相符不等於來源已獲發布核准、功能相容或實際運行的版本組合驗收。輸出固定保留 `deploymentPerformed=false`、`sourceAuthorizationVerified=false`、`functionalCompatibilityVerified=false` 與 `releaseEligible=false`；release purpose 只要求 `origin-main` metadata，正式來源仍須另外執行發布來源檢查。證據檔限制大小並拒絕非一般檔與 symlink；CLI 失敗只回報簡短錯誤，不輸出配置原文。

第 169 號 run `44839367090` 的 image job `136643642158` 失敗：末尾保全 assertion 仍禁止所有 bind mount，與已加入、已驗 SHA 的單檔唯讀 native fixture 衝突。原 artifact `14681111143`、ZIP digest／CRC／bytes 與 terminal log 已保存核對；pair 報告為零 bytes，該輪不記成雙映像成功。本次只允許 web 的一個指定路徑／來源且唯讀的 fixture bind，Python 仍不允許 bind；其他 mount 檢查保留。原 CI 不重啟。

本機 55 個相關案例通過：29 個 Compose、26 個版本清單案例。固定 AST inventory 新增 37 案，完整預期為 179 檔／2,960 unit；browser 維持 81 檔／843。型別檢查、完整建置及編譯 smoke 通過。實際 Docker Compose 在合成 metadata、空目錄與空 env 上解析及校驗通過，沒有使用本機 Docker 引擎或啟動服務；這不是實際映像驗收。本提交自己的 Linux CI 及實際映像回報仍待核對。

166 capabilities 仍為 0 fully accepted。保留 Python bot 與最終 TypeScript worker 的全 B01–B15、正式待送工作保全、來源／reset 世代、media／browser pending、QQ／WebView、實際版本組合及完整切換驗收仍待完成；這份離線清單不放行切換。
