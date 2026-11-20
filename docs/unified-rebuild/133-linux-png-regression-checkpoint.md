# 固定 Linux PNG 回歸與映像檢查點

日期：2026-11-20。發布範圍 **`none`**；本檢查點驗證已提交的前台／CI 修正，不部署、不合入 main、不使用正式資料或 QQ。

固定來源 `083555fbb1795d240f8a36b33660b2d5be233eba`，tree `9c950f9c798f8384d3e5dee97ecf3246ba844b6e`。兩個遠端功能分支已分別核對相同完整 SHA。[GitHub run 44660842619](https://github.com/lyangjyehaur/jmusic-qgroup/actions/runs/44660842619) 分別執行 unit、browser、image jobs；來源固定後的後續工作不能混入本次結果。

## 完整瀏覽器結果

78 檔／833 項完成，832 passed、1 failed，零 skipped／retries／flakes。固定 public Umami client 與圖片停滯的新 regression 均納入。這次絕對 reporter 路徑正確，完整 `browser.json`、trace、error context 與 screenshots 已保存；獨立核對全部 ID、title、file、line／column 與執行前 inventory 一致。

唯一失敗是 `time-polls.spec.ts` 的原日期候選重排／刷新案例：刪除中間候選後，测试接受 unload dialog，在最新 IndexedDB 交易 commit 前刷新，實際恢復上一份候選。這不能算成保存成功。修正測試先核對已完成的 durable transaction 中原候選順序，再刷新；原回復、日期、建立、匿名舊 bot 連結和零 POST 斷言保留。沒有使用固定 sleep 或 retries。整份 11 項投票 spec 在 Chromium 159 的本機開發回歸通過；修正仍須取得新的完整 Linux 結果。

此前修正的 PNG generation／bounded fallback、finance／erasure／language／legacy request 時序案例在這次完整 Linux browser report 中均通過。833 項僅有上述一項失敗，仍不能宣稱全套通過或沿用部分綠燈放行。

## 實際映像與已建置 bot

image job `136038411563` terminal success。由指定提交的乾淨 rehearsal archive 建置實際 Linux amd64 image：`sha256:d42956403a5984834d8f19570969eb6a52de24e9c772e3f6e1d4349836f3b153`。核對來源 tree、OCI revision、實際 image ID、UID/GID 994/992、readonly rootfs、network none、512 MiB／無額外 swap、1 CPU、128 PID。空私人 DB／authority／readonly checkpoint 的原生 SQLite／sharp／React、schema 15、24 shell／4 error display／4 source archive 檢查、authority flock、SIGTERM 與清理全部通過。

同一映像的實際 compiled bot／database 使用既有兩輸入 harness，通過 loopback HTTP／WebSocket、ACK／Resume、public reply、dispatch／callback、縮寫完整交付、sensitive diagnostics、uncertain／simulation／recovery block 及原生 CLI ownership／SIGTERM。harness SHA256 `9980ec272a1d0263a553e7408a5e17a54ad4118768cbaf664e2a30478788f0df`；在另一份乾淨固定提交 checkout 封存來源，再生成 harness，完整 manifest／Git blob hashes／compiled bytes 均相同。

這份映像包含 PNG 修正，沒有包含後來的 [134 號 bot 鎖檔別名修正](134-retained-python-owner-checkpoint.md)。其原有 ownership smoke 不等於新的別名 regression 已在 Linux 通過。沒有実際 image＋保留 Python bot 成套驗收或真 QQ 投遞。

## 私人證據與門檻

私人目錄 `/Users/danersaka/.codex/rebuild-verification/linux-133-1f69b629055740a4b68e155951e2c7a7/` 保留 source pins、執行前 browser inventory、原 job logs、完整 JSON、artifact metadata／原 zip、固定來源 archive、重新生成的 harness 及 `independent-image-receipt.json`。

image artifact `14594823778` 的原 zip SHA256 為 `f9d58e2bba4fa0cc39c8ce123eea057b50be5bc7823e55e35ed0132ae1f9c730`；browser artifact `14596377405` 為 `0271e24fcb4298b5937a444d16c18508391d2f1a412f0be513554f6bd6d0215c`。均核對 GitHub digest 與解包 bytes，沒有把被丟失的舊 JSON 補造成新證據。

unit job 在這份記錄建立時仍執行中；不能提前宣稱 2,325 項全部通過。即使 unit 通過，browser 的真實失敗仍令本次完整 run 未通過；新修正與 bot guard 必須重新取得完整固定提交的 unit／browser／image 結果。

166 項仍 `in_progress`，0 項 accepted，`release_eligible=false`。原完整重構／資料／bot／裝置／來源保全／回退驗收範圍沒有縮減。不部署。
