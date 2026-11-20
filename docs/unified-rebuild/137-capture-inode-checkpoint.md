# Capture inode 保全與共用 fixture 回歸

日期：2026-11-20。發布範圍 **`none`**。離線 capture 讀取規則按 **`both`** 檢查資料與 bot 保全影響；沒有修改 web／bot 運行程式、schema、正式 Compose、憑證或群設定。不部署、不合入 main。

## 新雙映像結果

[run 44670100869](https://github.com/lyangjyehaur/jmusic-qgroup/actions/runs/44670100869) 固定來源 `026779924922022dc10f821cee0642ce421a2d9b`，tree `14279f46100c4308b83f8da373492f3ce0a9d60a`。image job `136068744358` 已 terminal success，完整 JSON／Git pins／原 ZIP bytes／重新生成的 source-only archive 與 manifests 已獨立核對。實際網站 image 為 `sha256:2d3440826d4423ae379526c04e2ff5712bea44149301c7b8f9f5ee4ea09717a3`，原 Python 驗證 image 為 `sha256:178455a4c3dae44c8774452aac2508100c11804ec7fe3a963016334f373f2176`。

全部 55 個原 Python blobs、原 Dockerfile 與實際 `websockets==17.4`、禁止 network 下的原 WebSocket dependency 載入、三模式的完整主動投遞 counters／被動 router／callback、85 次 HTTP／10 次 fixture／52 個 shell、原生 TS bot harness／CLI ownership、兩邊 exit 0 及清理通過。文字與 Markdown 各核對 55 個被動 Mock 回覆；模擬零回覆，相關內容 assertion 為 null。這仍不是實際 QQ gateway／heartbeat／token 或全部 B01–B15 驗收，也不是目前線上 Python bot 的版本證據。

image artifact `14599453669` 原 ZIP SHA256 為 `52aa1f91f37bbd7705bdff992be7b842573457b305e541537c0e43b75a2d72a6`，pair report SHA256 為 `9bd3b28decfa75dd1a8ea0171c27adee22880ff8b06acd3c9eea6d18ceae01f7`。實際 image build 只在乾淨固定來源的 Linux CI 執行；本機後續 source-only Git archive 只重建核對 manifests，沒有從 dirty workspace 準備或建置映像。

## 真實 unit 失敗與修正

前一個 [run 44667859100](https://github.com/lyangjyehaur/jmusic-qgroup/actions/runs/44667859100) 已 terminal failure。149 檔／2,331 項 unit 為 2,330 passed／1 failed，零 pending；browser job 與 image job success，不能記為全套通過。unit artifact `14600080564` 原 ZIP SHA256 為 `7f6016a367c6527735dfed641a4822973fdba72cc05982c7a367f2da84d4edd0`。

唯一失敗是 `retained-erasure-config.test.ts` 的 image fixture 案例：抽出共用 `synthetic-image-fixture.mjs` 後，原測試仍從 `verify-image.mjs` 用舊正則取出 inline body，得到 undefined，未能進行後續核對。現在直接載入實際共用模組，同時確認 image consumer 使用該模組。原 checkpoint 可攜性、authority／schema／recovery flag、拒絕重用及來源 bytes 不變的 assertions 全部保留；沒有刪除案例、加入 retries 或調高 timeout。

第 136 號來源也包含這個尚未修正的抽取方式，image 成功不能代表其完整 unit／browser 已通過。新的固定來源必須重新取得完整回歸。第 134 號的完整 2,331／833 通過結果仍只綁定 `b9c7b113247241ea722ae68f3d9d390dcd1b2b77`。

## Capture SQLite／SHM 保全

`captureSnapshot` 會同時持有 board 和 identity 的 SQLite writer lock，再讀取私人歷史、壁紙、媒體和 bot evidence。歷史檔案若是活躍 SQLite／WAL／SHM 的硬連結，raw open／close 可能提前解除本程序的 POSIX locks；同程序的 SQLite rival 看見 locked，不足以證明另一程序仍被擋住。

現在先以 metadata 核對兩份 DB 及所有現有 journal／WAL／SHM 為唯一 regular inode，不接受 symlink、硬連結或互相重用同一 inode。SQLite 取得鎖後固定完整 inode 集合，所有 raw 讀取先檢查來源唯一性並拒絕已知活躍 inode，不打開這些已知別名；最終再次核對 DB／sidecar 集合、原 bytes／inventory、維護鎖與完整 stopped-service evidence。

若路徑恰好在 metadata 與 open 之間被替換，fstat 發現 descriptor 指向保護中的 SQLite inode，就拒絕且暫存該 descriptor。不讀取其內容、不立即 close；先 rollback／close 兩份 capture SQLite connections，再 close 暫存 descriptor，最後釋放維護鎖並清理 stage／reservation。metadata 失敗也保守延後 close。這項處理避免失敗清理本身提前解除 capture 的原鎖，不宣稱能取代真正停止所有來源寫入者。

新增 8 項 regression：兩份 DB 各測 main／WAL／SHM 硬連結，及各一個 metadata→open 的 SHM 路徑替換。前六項先在原連線持有 writer transaction，拒絕後移除測試別名，再由另一 Python 程序確認原 writer lock 仍有效。後兩項在 raw open 前／close 前用外部 Python 程序檢查：開啟前仍 locked，close 只發生在兩份 capture connection 釋鎖後。沒有只靠 constructor 拋例外、同程序 lock cache 或 JSON 成功旗標判定保全。

## 本機驗證與剩餘門檻

完整 capture 檔 49 項、authority／image fixture 檔 13 項，共 62 項全部通過，零 failed／pending；strict 與 166 項台帳檢查通過。原 capture 的 41 個案例及全部 bot pending／sending／sent／failed／skipped／simulation rows、claim／retry／payload、原 WAL、schema、歷史與圖片配對 assertions 保留。新八項納入後完整 unit inventory 預期為 149 檔／2,339 項，仍須固定 Linux 完整結果。

私有證據續存於 `/Users/danersaka/.codex/rebuild-verification/linux-135-0b62237c4900470a9356d1442a33dad7/` 及 `/Users/danersaka/.codex/rebuild-verification/linux-136-5c0c4c3754014068bf64f4c8081f2db5/`。保存 image 的獨立 receipt、unit 原失敗 JSON／ZIP／log、完整 62 項本機 report、strict、原 source-only archive 和 manifest 核對。

166 項仍 `in_progress`，0 項 accepted，`release_eligible=false`。完整 music erasure／reset generations、外部 ancestry／custody／高水位、私人歷史 latest-erasure、media／browser pending／proof、真正停止來源服務的 capture 演練、完整 bot／實機 QQ／TS bot＋actual web 及 audited activation 仍待完成。
