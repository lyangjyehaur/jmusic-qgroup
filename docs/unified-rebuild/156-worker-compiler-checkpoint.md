# 固定 worker 編譯設定

日期：2026-11-21。變更範圍：`web`；PWA worker 的建置設定。沒有部署，API、schema、outbox、bot 設定與入口沒有變更，保留 Python bot。

第 155 號實際 Linux image 的 82 資源／277 HTTP proof、85 個完整 precache 資源及每批 bytes 全部等於本機，但 worker build ID／SHA 不同。原因是 Docker build 只複製 `tsconfig.rebuild.json`，本機另有舊根目錄 `tsconfig.json`；esbuild 自動搜尋設定時，前者使用預設，後者使用 strict 模式。以固定第 155 號封存來源及 Docker 的無舊設定條件，獨立重新編譯後精確重現 image build `91fc0ea0e91bf866a19e8776f4d276ef8288319fe75e641aaa2b27de0230c567` 與 worker SHA `2156077597adb66106b7060b57ff1915d1ba096787c424f3cadfc733f866cef5`。原不同結果與驗證失敗保留，不把它說成全產物相同。

root／retirement worker 的 canonical version 編譯及 final worker 編譯共用 helper，現在明確指定本專案的 `tsconfig.rebuild.json`。不依舊專案設定檔是否存在決定語意；也不把舊設定檔搬進新 Docker 作為依賴。

新增真實編譯案例：entry 附近先放非 strict tsconfig，再換成 strict tsconfig；worker 都必須依 rebuild 設定採 strict，canonical bytes 逐 byte 相同。固定第 155 號 helper 在第一個條件得到 `false !== true`，失敗證據保留；本次 **5／5 worker unit**通過，前 4 個既有宣告逐項保留。**4 檔／25 browser**通過，覆蓋真實 compiled worker 的完整快取、最後一批等待、失敗／重試，以及完整 PWA、lazy page、成分工作區；固定 IDs／宣告位置完整相同，沒有 skip／retry／flake。

strict、完整建置與 built smoke 通過。公開快取仍為 **85 資源／1,720,579 decoded bytes**，最大原子 cache operation 為 **4 資源／619,197 decoded bytes**，沒有重疊操作；built static 仍為 **82 資源／277 HTTP**。這不是瀏覽器 heap／RSS、線上流量或正式負載驗收。

第 155 號 run `44779742495` 的原 image ZIP `5c330d70c60348532088998331513933837f4c8ccb4a84e294240d274f5569c6` 已核對 metadata、CRC 與全部 extracted bytes；55 原 Python blobs、實際雙映像、三種合成模式、85 HTTP／10 原 worker invocations／52 deep links 與清理已獨立核對，worker 的設定差異另有精確重建證據。unit／browser jobs 的原完整結果仍待終態，不能以 image job 成功代表整個 run 成功。

新固定來源預期 **168 檔／2,682 unit、80 檔／840 browser**；須取得原 Linux完整 reports、job logs 及實際 image 的一致建置證據。166 capabilities、0 fully accepted、`release_eligible=false`；其餘完整恢復、歷史、待完成操作、bot 實際候選組合／B01–B15／QQ、資源規模與切換驗收繼續。不合入 `main`、不部署。
