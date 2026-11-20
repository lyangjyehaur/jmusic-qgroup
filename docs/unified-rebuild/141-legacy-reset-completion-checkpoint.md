# 原始重設完成結果與固定回歸

日期：2026-11-20。發布範圍 **`none`**；遷移／恢復相容性按 **`both`** 評估。不部署、不合入 main，沒有操作正式資料、憑證、群設定、待送工作或服務。

## 完成結果的持久保存

第 140 號已在原 reset 前保存 persisted／loaded 兩份來源。本次在原服務完成清除後、回傳成功前，再保存真實 `result.json` 與最後 fsync 的 `completion.json`。完成宣告綁定原 capture／snapshot、原 authority record SHA／sequence 及結果 size／SHA；同時核對原服務 loaded state 與磁碟內容，確認 entries／members／shouts／shoutHistory／trend 五容器都存在且已清空。

使用原 capture 的目錄與新 inode 的獨佔建立流程，逐檔 fsync 並重查 metadata。全 vault 的 128 MiB 上限現在包含 persisted、loaded 與 result bytes；每份仍 64 MiB，最多 1,000 captures。保存完結果後再次核對真實服務檔案；中途換檔、loaded／persisted 不同、未清空、權限不符、容量或既有目標造成的寫入失敗都拒絕成功回覆。已記錄的 intent、原來源與部分結果原樣保留，未完成核對前不重試清除。

私有來源要求 0600，舊服務本身的 `save()` 依 process umask 建立新檔。隔離演練以 0077 umask 執行；若 caller 讓結果變成 0644，新增檢查會停止完成確認，保留操作前快照及原 intent。overlay 不修改整個程序的 umask，不自行 chmod 可能被替換成 SQLite alias 的既有檔案。

reader 繼續接受只有三份操作前檔案的原 capture；有完整 result／completion 時逐項核對 pins、實際 record、五容器與所有檔案 fences。只有 result、缺 completion 的部分保存拒絕讀入。TS 提供 pinned completion byte copies 與 `allRecordedResetCompletionsPresent`，操作前來源仍經原雙來源 verifier 核對。

原操作前 snapshot、完成後空資料及下一次 reset 前的新內容已有各自來源；跨世代 ancestry、設定與身份的完整重建、後續寫入／key reuse 和業務三方合併仍待完成。完整 result 不能單獨放行恢復，`resetGenerationsReconciled=false`、`externalRetentionVerified=false`、`releaseEligible=false` 及原 startup gates 保留。

## 本機驗證

完整 vault 檔 **42 項**、原 reset authority **40 項**、原雙來源 **18 項**，共 **100 項通過**，零 failed／pending；strict、台帳及 diff 檢查通過。

包含兩次真正的原 Python reset、操作前與完成後原 bytes、不同 loaded／persisted 世代，以及結果／completion fsync 後真正 `os._exit`。只有結果檔的中斷被拒絕，完整完成宣告可以讀回；原生 DB 與 pending／sending／sent／failed／skipped 的所有 bot rows 保留。

另驗證 result 0644、結果目標為 identity SQLite symlink、完整來源已占滿容量、保存時真實服務換檔、未清空與 loaded 不符。result／record／snapshot pin、缺檔／symlink 都拒絕；即使重新計算 size／SHA 並用原 Python canonical encoding 保存，含復活 entries 的自洽 result 也拒絕。原有 root／instance、崩潰、捕捉篡改與父程序 SQLite 寫入鎖保全案例仍全部通過。

新增完整 inventory 預期 **152 檔／2,423 unit**；browser **78 檔／833 項**。本機 focused report 沒有替代本次固定來源全套 CI。

## 已核對的固定 Linux 結果

[第 138 號 run 44675054259](https://github.com/lyangjyehaur/jmusic-qgroup/actions/runs/44675054259) terminal success，固定 `0f6dc8f1fc6ee9d79a33a9cedb08928bb665888f`：**150 檔／2,363 unit**、**78 檔／833 browser**，全部預期 identity／location／inventory 相等，每項 passed once，零 skip／retry／flake。unit artifact `14603307695` ZIP SHA256 `1867af268aa0feb2be1f29235a471c255772b44848306d63386b77d1ec672768`；browser `14603660661`：`111ac48bc96fe8af09b4e5795c3340addff7964f7f864f7f9fd535086dd24eeb`。原 terminal JSON、三份完整 job logs、GitHub digest／ZIP CRC／全部解包 bytes 與獨立 full CI receipt 已保存。

[第 139 號 run 44676623525](https://github.com/lyangjyehaur/jmusic-qgroup/actions/runs/44676623525) terminal success，固定 `11934abb238f938f3f7099dfad35ea7d91474170`：**151 檔／2,381 unit**、**78 檔／833 browser** 完整 inventory 與每項 passed once 核對通過。unit artifact `14603648542` ZIP SHA256 `36a9f3faad19d9cb495952077cc09ef2a12709173921926043d4fbbece7c3de9`；browser `14603471930`：`34f4353bfb3dfd9a73deb330a11ed81a039d4182df6a91528f2f09f436699dcb`。原 reports／terminal／logs／ZIP 與全部解包 bytes 已保存與核對。

兩份 browser artifact 的 retained Python＋compiled development web report 均另核對 55 原 Git blobs、175 runtime inputs、兩個 bundle pins、fixture／scenario、三模式完整 counters／原 dispatcher／callback、52 shells 及不重播已送／模擬工作；保持 development commit／tree 為 null。兩個固定來源的实际雙映像另有獨立 report，沒有把 development report 當作映像身份。

[第 140 號 run 44679257574](https://github.com/lyangjyehaur/jmusic-qgroup/actions/runs/44679257574)，固定 `ee7f2da41d83e0dba4f758cf65148a9fb4b14e52`、tree `6992e38b1e861462c45dbc5b04a7a432b776b5da`：image job `136098453767` 已成功且獨立核對。web `sha256:5f9f0c16d8e5750ea46b6806bd254ae029f7e1992e48621b39f30d48fc9be5ba`；固定 Python `sha256:ba7d86f0783edc645410aa4407b1f355ecddca0ed7ab2da8320059e665ad6821`。artifact `14602619875` ZIP SHA256 `dba1201bb5ee99de2a17a8441cb85bd37756334ccbdd1c33c96be39d806dd8b5`；pair report SHA256 `5c98c5005980de04f5a4635d33174d6d43d59f06a74e8ddf114852ec5066846f`。manifest／harness 從該乾淨 Git archive 重新生成，原 Dockerfile／websockets 17.4／55 blobs、三模式原 dispatch／callback／投遞、85 HTTP／10 fixtures／52 shells、退出清理與原 ZIP 均通過。unit／browser 仍待終態，本次 completion 修改未套用其結果。

以上盤點 Python 與合成平台不代表目前線上 bot 版本或實際 QQ／完整 B01–B15 驗收；第 136 號歷史失敗仍保留。

## 後續門檻

166 項仍 `in_progress`、0 項 accepted、`release_eligible=false`。完整 music erasure／舊與原生全域 reset 世代、外部 epoch ancestry／custody／高水位、私人歷史 latest-erasure、media／browser pending／proof、真正停止來源的 capture、完整 TS bot＋實際 web 版本組合／B01–B15／實機 QQ／正式規模，以及 audited activation 仍须完成。
