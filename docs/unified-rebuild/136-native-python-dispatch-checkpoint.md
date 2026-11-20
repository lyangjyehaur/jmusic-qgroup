# 完整 Linux 結果與原 Python 事件處理驗證

日期：2026-11-20。發布範圍 **`none`**。這批只修改隔離驗證工具、專用測試映像及文件；原 web／Python bot／TS bot 程式、schema、正式 Compose 和群設定沒有改動。不部署、不合入 main。

## 已獨立核對的固定來源結果

[run 44664800858](https://github.com/lyangjyehaur/jmusic-qgroup/actions/runs/44664800858) 的固定來源 `b9c7b113247241ea722ae68f3d9d390dcd1b2b77` 已 terminal success，三個 jobs 全部成功。149 檔／2,331 項單元測試和 78 檔／833 項瀏覽器測試逐項 inventory 完全相等，全部 passed，零 failed／pending／todo／skipped／retries／flakes。原投票保存時序及新的 12 項 ownership regression 均納入，沒有以部分綠燈取代完整結果。

原 artifacts 的 ZIP digest 與所有解包 bytes 均核對。unit `14599310902` SHA256 為 `75403ba8b86e66a2c4263f40febd5e0d9e3a3bd1bd071cd453407a39ab34fcdb`；browser `14598611057` 為 `8e124dc9194bb9a8bdef6385b76868bb1748a1b48b620ae5c805ed2eb0cb5b6a`。完整單元／瀏覽器／image job 原 log、run 終態與獨立 receipt 均已保存。原 Python＋compiled HTTP 網站 report 另核對全部 55 個 Git blobs、fixture、三種完整 poll counters、54 個別名／52 個 shell、私人通知、已送 rows 及模擬不重送；這份 report 仍是 development bundle，不假稱為 actual image。

[run 44667859100](https://github.com/lyangjyehaur/jmusic-qgroup/actions/runs/44667859100) 的固定來源 `f534eee67c352fe72e88541fe48b11866309005e`，tree `7ce9a93098cdbfb7687de2789c85e42cafb90c51`。建立本文件時 unit／browser 仍執行中；image job `136061463843` 已 terminal success。以下是這個 job 的實際兩映像組合，不能混入本文件後續的新增事件處理驗證：

| 服務 | 實際 image ID |
| --- | --- |
| 新網站 | `sha256:c9a48c7ecdd22d67f57682ec2c175d7899ca17b8a04e670dde19b253e55830fd` |
| 固定原 Python 驗證映像 | `sha256:ff9f810fa5ae383da5c1dac279bb2d7cc162469f6edcc38616430a44d3ba7a71` |

同一份合成 SQLite 的 85 次真 HTTP 操作、10 次原 worker fixture 執行全部通過。三模式的發布／報名／退出遞補、原回執、私人成員通知、設定版本、未來提醒與模擬不重送逐項核對；52 個舊連結只證明 React shell。核對兩個實際 image inspect／OCI／source tree，55 個 Python blobs、三份工具 Git inputs、固定來源重新生成的完整 Python manifest／bot harness／bytes、資源與網路限制、兩邊 SIGTERM exit 0 和清理結果。

image artifact `14598841566` 原 ZIP SHA256 為 `5f17c3048ad7e9ec9a9704cd87a27512f6c4a99141359d231e1ec83090eca042`，pair report SHA256 為 `ac141869288dab5c9c4e6f1d8686782d82af7e32c9511f62f7c5876cd617b973`。這個已驗證的 Python image 只執行 outbox／query fixture，沒有驗證完整 bot 入口與 WebSocket 依賴；不能據此宣稱被動事件、gateway 或正式 Python bot 已完整驗收。

## 新增原事件處理流程

`retained-python-fixture.py` 現在另外從同一個固定原 Git archive 載入 `qgroup_bot.main.Bot`。只替換 `QQBotAPI` transport 為 process-local Mock；保留原 constructor、事件判斷、指令解析、policy 讀取、去重、回覆格式及按鈕處理。沒有複製或重寫測試用 bot router。

每次執行注入 READY／RESUMED、54 個非縮寫別名的 @事件、同 ID 重複／另種事件、未提及 bot、@everyone、bot author、拒絕群及按鈕事件。文字／Markdown 模式各核對 55 個 Mock 回覆，包含全部 54 個原文、keyboard、Markdown／fallback、seq、message ID，以及 `/我的` 的未綁定提示。每種模式均核對兩個 callback ACK、重複 callback 不再 ACK、拒絕群只 ACK、不回覆。實際 callback 先 ACK 再回覆，保留外層 event ID；模擬模式沒有回覆，相關回覆 assertion 在 report 中為 null，不能假稱已發送並驗證內容。

三次發布／報名／退出的原 worker poll counters、設定 revision、已送 rows、未來提醒及原 request 回執檢查繼續保留。新增被動 Mock 回覆與主動 outbox Mock 投遞分開計數；最後切回真送設定時，新注入查詢可以產生 Mock 回覆，先前模擬的 outbox 仍零重送。原私人備註不進任何群回覆。

Python asyncio 的 executor 使用內部 Unix socketpair 喚醒 event loop。先在尚未匯入 bot 時建立這份 event-loop plumbing，隨即禁止所有新 socket；Bot 執行期間不開放網路。開發時第一次直接使用 asyncio.run 被 guard 拒絕，修正為持有已建立的 loop 並在結束時 shutdown executor／asyncgens／close，沒有放寬 socket guard。開發失敗不計入通過證據。

專用 Python 驗證 Dockerfile 補入原版本 Dockerfile 固定的唯一第三方依賴 `websockets==17.4`。preparer 保存原 Dockerfile blob／SHA 和依賴版本；容器 source probe 比對原檔、實際 installed version，並在禁止 network 下確認原 `main.ws_connect()` 能載入。這只證明依賴與原入口可載入，不是 QQ handshake、heartbeat、token 或連線恢復的實機驗收。

## 驗證與門檻

新增原 router 情境在本機三模式通過，使用固定 55 個原 Python blobs 與真正 compiled HTTP 網站。fixture／scenario／native bundles 前後 hashes 不變，沒有網路 transport，SIGTERM 與私人 fixture 清理完成。提交後仍須取得包含這批新增 assertions／WebSocket dependency 的 Linux source probe、原 fixture 及新的實際兩映像結果；上面的 `f534eee` 映像不能代表這批尚未提交時的修改。

私人證據位於 `/Users/danersaka/.codex/rebuild-verification/linux-134-bf5667635e764bf48a267c00843f15a7/` 與 `/Users/danersaka/.codex/rebuild-verification/linux-135-0b62237c4900470a9356d1442a33dad7/`，保留原 ZIP／JSON／logs、獨立核對 receipts、重新生成的固定來源及本機原 router report。

166 項仍 `in_progress`，0 項 accepted，`release_eligible=false`。固定原盤點 Python SHA 不等於目前正式 bot 的實際版本。完整 B01–B15、TS bot＋actual web 組合、真 QQ／裝置／正式規模、完整 music erasure／reset generations、外部來源保全／高水位、歷史 latest-erasure、media／browser pending／proof、真正停寫 capture 及 audited activation 繼續保留。
