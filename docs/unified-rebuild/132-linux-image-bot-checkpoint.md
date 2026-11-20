# Linux 映像、已建置 bot 與瀏覽器恢復檢查點

日期：2026-11-20。發布範圍 **`none`**。本輪變更影響為 **web** 及隔離驗證工具：修正前台 PNG 轉換、CI 和測試時序。API、資料模型、Python bot 與 TS bot 運行原始碼未修改。不部署、不合入 main，不使用正式憑證、群設定或真實待送工作。

## 實際映像演練

固定提交 `0ff21806c5577d5a775e4e4b72fd9501967b273a`，tree `cee9af1b0ee274b5ecd66effb165b5c12746ff43`。GitHub [run 44654435173](https://github.com/lyangjyehaur/jmusic-qgroup/actions/runs/44654435173) 的 `isolated-image` job 在 01:33:11–01:35:03 UTC 執行並通過。從乾淨 checkout 呼叫 `prepare-image.ts --purpose rehearsal`，只封存指定完整提交，在新的 context 建置 `deploy/unified.Dockerfile`；不是封存任意 HEAD 或上傳工作目錄。這是 feature 分支的隔離演練映像，不是正式發布來源。

實際 Linux amd64 image ID：`sha256:547a88ff3f15d7b750bd411e40b7b34f8b9385e79269f3da9cf8a754e502b0cf`。核對映像 revision、service version、來源 commit／tree；production 映像沒有 Python、舊 server.py、tsx 或 TypeScript 編譯器。映像原生 SQLite／sharp、React assets、schema 15 均可使用。

web 演練使用三個全新空私人 volumes：業務 DB、erasure authority、唯讀 checkpoint。fixture 使用原 service UID/GID 994/992 建立空 DB／authority；sourcePackage pin 明確標為 `synthetic-empty-image-fixture`，不能作原始資料的捕獲或 custody 證據。驗證 production 啟動、authority flock 排除競爭程序、checkpoint 不可寫及 SHA 不變；SIGTERM 後 exit 0、無 OOM，authority lock 可重新取得。

實際容器檢查 network none、rootfs read-only、cap-drop ALL、no-new-privileges、512 MiB memory、同額 MemorySwap（無額外 swap）、1 CPU、128 PID，以及三個 mount 的 RW 權限。24 項 GET／HEAD 簡繁頁面、4 項 API 錯誤顯示與 4 項成分 source archive 投影檢查通過。這些是空 fixture 的資源限制與原生運行證據，未量測正式規模的 RSS／延遲。

## 已建置 bot

`build-image-bot-smoke.mjs` 從同一封存 context 編譯既有 `smoke-bot.ts` 與 loopback platform helper，完整保留原斷言。唯一匯入調整是把 source database 改為 `/app/.rebuild-dist/api/database.mjs`；metafile 必須恰好只有兩個 fixture inputs，拒絕把 source database／API／bot implementation 打進 harness。readonly mount 保留 `tools/rebuild/` 深度，原 dynamic URLs 載入映像內全部 9 個 bot bundles。

harness SHA256：`9980ec272a1d0263a553e7408a5e17a54ad4118768cbaf664e2a30478788f0df`。與本機相同封存來源生成的 bytes 相同；兩個 inputs 分別以提交 Git blobs 重新核對 SHA。測試程式只掛入演練容器，不加入發布映像。

在相同 512 MiB／1 CPU／128 PID／read-only／network none 限制下，實際 bot 模組與 native CLI 通過 inert imports、本機 HTTP／WebSocket、ACK／Resume、public replies、群訊息與回呼 dispatch、敏感身份不入診斷、縮寫遮蔽／持久 continuation、outbox uncertain／simulation／recovery block、唯一 ownership、只送一次及 SIGTERM 退出。原 upstream lookup 由 fixture 提供；token／gateway／群消息 transport 只到容器內 loopback mock，沒有真 QQ 授權或投遞。

這次比 version／synthetic health 多執行了實際 compiled worker；仍不能宣稱 B01–B15 全部已在實機或新版網站＋保留 Python bot 的實際版本組合通過。

## 證據與清理

`verify-image.mjs` 在失敗時保留唯一合成容器的 startup logs；即使 `docker run` 超時，也以成功的 engine inventory 查詢確認該唯一名稱。逐項清理所有已建 volumes，容器／volume 清理失敗就拒絕成功，不把 engine error 當成容器不存在。成功 JSON 在 finally 清理完成後才輸出，包含 `cleanupVerified=true`。bot smoke 有 90 秒執行上限、退出清理及成功的 engine inventory absence 檢查。

私人目錄：`/Users/danersaka/.codex/rebuild-verification/linux-132-8c12d764d24148f7b1f3860d89a8cbaf/`。保存原 job log、完整 image inspect、source／image／harness reports、bot smoke log、GitHub artifact metadata、原 zip 與獨立 `independent-image-receipt.json`。artifact ID `14591634419`，zip SHA256 `725d01f5e78d84cff18369795809bac2e9f7d93859ec8b4cc68c36dc020556ae`，與 GitHub digest 相同；zip 每份 bytes 也等於下載解包資料。獨立核對 job terminal success、commit／tree／OCI label／image ID、兩份 fixture Git blobs、harness bytes、限定的 runtime 結果與清理。這份 evidence 不包含映像 tar 的長期保全或 registry 發布。

## 完整 Linux 回歸

第 131 號 run 44652759268 已正常跑完：unit 為 2,270 passed／55 failed，零 pending／todo；全部失敗均為明確的預設 5 秒 timeout，位於五個完整資料庫重建 fixture 檔，實際耗時 5.016–10.598 秒。第 132 號 run 44654435173 重跑為 2,265 passed／60 failed，失敗也全部是同樣的 5 秒 timeout，最大 10.606 秒。這次已有完整 failure stack，不能沿用第 130 號本機結果宣稱 Linux 通過。CI 保留一個 worker，僅把整個 testcase 的上限改為有限的 30 秒；原斷言、子程序／業務操作 timeout、來源與對帳條件不放寬。新設定須取得實際 Linux terminal pass。

兩次 Linux browser 分別為 827 passed／5 failed 與 830 passed／2 failed。trace 證實部分測試在 IndexedDB commit 前刷新、原請求發出前離頁，或以原頁介紹的「格式」字眼誤認已收到回應；另有 selector 同時命中保存中與衝突兩個 status。對應測試改為等待實際持久資料／原 POST、精確 API 讀取錯誤及指定衝突提示。所有原資料、write count、回執和權限斷言保留；不使用固定 sleep 或 retries 隱藏失敗。

原 CI 使用相對 PLAYWRIGHT_JSON_OUTPUT_NAME，reporter 以 config directory 解析而寫至 apps/web/artifacts/ci，沒有進入宣告的上傳路徑。已改用 PLAYWRIGHT_JSON_OUTPUT_FILE 的明確 workspace 絕對路徑；兩個舊 Linux browser runs 僅有 log／screenshots／trace，不能偽造完整 JSON receipt。後續須保存並獨立核對每個實際 case ID。

## PNG 轉換修正

Chromium 159.0.8154.6 在正常選項切換及跨分頁分享中可卡在「正在產生圖片」。只改為每次獨立 canvas 尚不足；單次 13 項曾通過，但重複兩個競態情境仍有三次失敗，這些開發結果不計為最終通過。

現在每次轉換有獨立 bitmap 與 AbortSignal。原生 toBlob callback 超過 1.5 秒仍未回來時，從同一 generation 的 canvas 轉為有效 PNG；原生明確失敗仍回原錯誤。單次 promise 只能完成一次，晚到 callback 不能替換結果；切換內容、登出或卸載會取消 timer／promise、清除 bitmap 並撤銷舊 URL。沒有新增展示文案或暴露私人留言／性別。圖片轉換的具體排程屬瀏覽器行為；這是避免無期限等待的恢復路徑，不宣稱已定位 Chromium 內部根因。

新增 browser regression 故意讓原生 PNG callback 不回來，要求仍產生有效最新圖片，再釋放舊 callback，核對最新 URL／尺寸不變。新的完整 browser inventory 為 78 檔／833 項（包含固定 public Umami client）；普通未提供 client 為 832 項。

目前五個受影響 spec 的 75 項在新 Chromium 全部通過，包含圖片重試、實際 PNG／配色、原生分享／取消、私人欄位排除、原操作／草稿保存、晚到結果和登出。兩個曾失敗的競態情境另重複三次，6／6 通過。strict／完整 build／隔離 build smoke 通過；全部 12 個 server runtime bundles（含 9 個 bot bundles）仍與第 130 號 bytes 相同。這些局部證據及上方舊映像不能代替修正提交的全套 Linux 回歸與新映像驗證；新 run 完成後另行記錄固定提交的結果。

## 保留門檻

166 項能力仍 `in_progress`，0 項 accepted，`release_eligible=false`。原 Python bot 保留。上方映像來源已在兩個遠端功能分支分別核對同一完整 SHA；前台修正提交與全套新證據仍須獨立綁定。

完整 music erasure／structured reset generations、外部 ancestry／custody／高水位、私人歷史 latest-erasure、media／browser pending／proof、真正停止寫入的 capture、完整實際 web＋Python／TS bot 版本組合、B01–B15／真 QQ／裝置／規模及 audited activation 仍需完成。不部署。
