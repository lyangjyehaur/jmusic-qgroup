# 固定 Python 與網站雙映像驗證工具

日期：2026-11-20。發布範圍 **`none`**。這批只修改隔離驗證工具與 CI；沒有改動 web／bot 運行程式、schema、正式 Compose、憑證或群設定。Python bot 繼續保留，不部署、不合入 main。

## 固定來源的既有結果

[第 133 號 run](https://github.com/lyangjyehaur/jmusic-qgroup/actions/runs/44660842619) 已 terminal failure：unit 149 檔／2,325 項全部 passed，完整 assertion 名稱 inventory、原 ZIP digest 與解包 bytes 已獨立核對；browser 78 檔／833 項為 832 passed／1 failed。投票保存時序已於 `b9c7b113247241ea722ae68f3d9d390dcd1b2b77` 修正，不能因此改記原 run 為成功。

[第 134 號 run](https://github.com/lyangjyehaur/jmusic-qgroup/actions/runs/44664800858) 固定來源為上述 `b9c7b11`，tree `408ed220cf47f6db8373bf714ba9239a46d0b4ce`。建立本文件時完整 unit／browser 仍在執行。image job 已通過，實際 image ID 為 `sha256:a3619842e9cdc3735a35bcfd81d2eb73aab15d32ef4784c56ef9d2bf6151a9f3`，包含新的 ownership guard。原 ZIP `14597142545` SHA256 為 `8ee720d87a4e62461d4da9665bbf9f188dfb373a696e943560f999116110d65d`；來源／tree／OCI／資源限制、實際 compiled bot、兩份 Git fixture inputs、重新生成的完整 harness 與 bytes 已獨立核對。不能把 image job 成功當成完整回歸通過。

## 同一組情境、兩個實際映像

`retained-python-scenarios.mjs` 共用原真 HTTP 測試的全部情境：三種模式、原 request ID／body 回執、正式及候補報名、退出遞補、私人成員通知、未來提醒、設定版本與已投遞紀錄不變、模擬不轉真送、指令別名及舊網址。保留原 assertions，另明確核對每次完整 poll counters、54 個唯一別名、52 個 React shell 入口及私人通知數量。沒有刪除 assertions、加入 retries 或固定 sleep。

本機 `smoke-retained-python.mjs` 仍使用真正的 compiled HTTP 網站及固定原 Python Git archive，保存 fixture／共用 scenario／native bundle hashes，完成後重驗來源與退出。雙映像 adapter `verify-retained-python-images.mjs` 在 web 容器內透過原生 `fetch` 送 HTTP、原生 SQLite 查資料，並在另一個 Python 容器執行同一個原 worker fixture；不引入測試用 API、database 或 bot implementation。

`prepare-retained-python-image.mjs` 從原盤點 SHA `8da877857f163853c449474e168534e2e493121b` 再次封存全部 55 個 Python blobs，逐份比對 Git bytes。另外核對已封存驗證提交的 fixture 與專用 Dockerfile。Python 映像的 revision 固定為原 Python SHA，verification revision 固定為本次工具來源；兩個實際 image ID、來源 manifest／55 files／fixture、web version／tree／兩份 native bundles，以及三份共用工具 Git blobs 均須核對。

`retained-python-rehearsal.Dockerfile` 僅供 CI 隔離演練，不替換正式 bot Dockerfile 或 Compose。Python 檔案置於 readonly rootfs；兩個容器以相同 UID/GID 994/992 使用同一份全新合成 SQLite。web 使用私人 authority 與 readonly checkpoint。只由單一 Python fixture 依序消費，沒有啟動 TS 投遞者。

兩個容器均 network none、readonly rootfs、drop ALL、no-new-privileges、512 MiB／無額外 swap、1 CPU、128 PID，不發布 port、不掛載工作目錄或正式資料。HTTP 在 web 容器 loopback 執行；Python socket 被拒絕，唯一 API 是 process-local Mock。檢查兩邊實際運行 image ID、正常 SIGTERM exit 0 及沒有 OOM；正常、失敗或中斷均只清除本次完整隨機名稱的容器／volume，清理失敗不得輸出成功 report。

## 本機驗證與未完成範圍

共用 scenario 的三模式本機重跑通過。新共用 fixture 初始化分別驗證空庫與兩個合成帳號，來源庫及 checkpoint 帳號一致，重用非空目錄被拒絕。strict 與 166 項台帳檢查通過。macOS 的 `/var` 別名第一次被既有 canonical-path guard 拒絕，測試改用 realpath 後通過；沒有放寬 guard。

本機 Docker engine 不可用，沒有宣稱雙映像已本機執行。CI 在 actual image job 加入固定舊 Python 映像的建置與共同資料庫情境；提交後必須取得並獨立核對完整 JSON、job log、原 ZIP、來源 pins、实际 image ID、每種模式的 counters 及清理結果。這裡仍是固定原盤點版本，不是目前線上 Python bot 的版本證據；完整 B01–B15、真實 QQ、裝置與正式規模尚待驗收。

私人證據續存於 `/Users/danersaka/.codex/rebuild-verification/linux-134-bf5667635e764bf48a267c00843f15a7/`，包括共用 scenario／fixture 的本機 report 與原固定 Linux 證據。166 項仍 `in_progress`，0 項 accepted，`release_eligible=false`。完整刪除／重設世代、外部 ancestry／custody／高水位、私人歷史 latest-erasure、媒體／browser pending／proof、真正停寫 capture 與 audited activation 等原剩餘範圍继续保留。
