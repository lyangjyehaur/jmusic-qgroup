# 退休會員的整組前向恢復

日期：2026-11-20。發布範圍：`none`；只修改隔離恢復工具，不啟動正式服務、不改正式 bot、憑證、群設定或真實待送工作。資料契約依 `both` 原則持續檢查，保留 Python bot。

## 已實作

新增 `reconstructForwardRetiredResetRecovery` 與 `verifyForwardRetiredResetRecovery`，把第 149／150 號的退休來源接到 global reset、business、proof 與 source rebase。先比對未經 reset 投影的原 native 會員資料，拒絕同一會員已有 native 新寫入的情況；共同 baseline 及 native fork 各自退休後，才分別重播原 erasure／global reset。兩次投影的 authority checkpoint 都維持原始完整 checkpoint，不能把退休 image 改稱原 authority 的來源。

整組來源使用原 baseline unified journal、退休後 baseline checkpoint／board／music／identity、獨立 native fork、原 latest board，以及第 148 號實際原 Store startup 處置後的 music bytes。原 generation IDs 由原 checkpoint／native 保留集合派生，私人 identity 先移除退休會員的 active recovery rows，再處理兩邊獨立追加 rowid 的碰撞。原 persisted scope 和 loaded scope 的區別維持，不把退休會員加進隱私 erasure ledger，也不合成 v3 erasure intent。

ForwardMusicInput 要求兩邊退休證據對應；退休會員不能出現在 current members、sessions、entry intents、links、prelinks、overrides 或 native recovery payload。舊 baseline retirement 不能被 native 無憑據移除；後續有真正驗證的 erasure 才允許轉為 erased。business 保留退休會員原 native rows，跳過 current member 的寫入；proof 把退休成分視為 unavailable，原擁有者 epoch 與保存回應由退休步驟失效。source rebase 保留退休會員原 profile source 的 payload、position、rowid 及原 migration map，新 active profile 的 source position 避開保留位置。

原 fields、不可變 history、退休證據、完整原 checkpoint／native images 及逐次私人 reset sources 保留。global reset 仍依原權威紀錄移除其 catalog／選擇等作用範圍，原內容可在 retained originals 查證；不能宣稱 reset 後 current 資料仍保有已重設的選擇。退休本身不等同隱私刪除，inactive contact reservation 保留原別名。bot 工作、設定、runtime、已送／模擬／重試／不確定狀態均逐列保持。

頂層 verifier 獨立驗證退休來源、generation reverse relation 及 identity row derivation，重新派生 erasure／source environment，再對實際 business、proof、rebase outputs 使用既有逐表 typed rows／rowid／schema／FK／sequences oracle。它不重跑後三個 writers；erasure source environment 的派生仍會執行 disposable projection 及其獨立 reconciliation，不宣稱全流程完全不重跑任何 writer。所有原來源、authority／vault files、retained images、中間產物、報告與最終 image 都受持續邊界檢查。

## 驗證

新增 **16／16** 案例通過；既有相關回歸 **236／236**，既有固定宣告與新測試 AST 展開後逐名核對最終報告，共 **8 檔／252 個不同案例**，重跑不重複計數。strict、功能台帳、diff、完整建置、實際 built API／TS bot／隔離 SQLite／blocked recovery smoke 與 compiled web／原 Python bot 三模式檢查通過。初期測試引用錯誤與本機 5 秒逾時的報告均獨立保留；修正後使用 CI 的 30 秒上限，完整重跑受影響檔案，不宣稱每次嘗試均成功。無 native fork 的 fixture 加兩次完整派生及 verifier 明確使用 120 秒上限。本批全量固定來源預期 **164 檔／2,643 unit**、**78 檔／833 browser**，仍须核對這一提交的完整 CI。新增案例包含真 persisted-only 原 reset、兩邊後續新增、原 fields／source／history 與 bot 工作保全、最終原 Python Store 恢復、inactive contact reservation、無 native fork、重複派生、實際 native 會員寫入衝突、重新釘選的 source／owner／bot／identity／generation／retained image 篡改、退休證據移除、偽造發布核准及晚期修改。

第 150 號固定 `e3894c2b34dda8f753cbf8f9bd76e28925a92cf2`、run `44737551163` 已 terminal success，三個 job 均通過。原全量逐案 inventory 核對 **163 檔／2,627 unit**、**78 檔／833 browser**，零 skip／retry／flake；三份原 job logs 已保存並釘選。已保存原 ZIP 並按 metadata digest／size、CRC、所有提取 bytes 核對：unit ZIP `f2bafdb286787806b868ce123438313edc3283720b21bc62797c2465b681dbef`，browser ZIP `cd585280e07107a0808dbd2ce0e1c7a4b8f5367eda1a22fb8029519c3391d936`，image ZIP `9dc220f6851550e5c7b44eac8ffe69b727ee1cabcacbaa1987e68be964dec161`。原 image pair 已核對 55 個原 Python blobs、manifest／harness、三模式、85 HTTP calls、10 次原 worker、52 入口及清理；compiled development Python 報告另核對 176 個 runtime inputs、兩個編譯產物及三模式 counters／dispatch。此為隔離測試，尚未驗收實際線上 bot 版本組合或 QQ。

## 剩餘門檻

這是退休恢復的完整離線候選，不會寫回原 authority、替換檔案、啟動服務或授權發布。原 generic recovery 的第 147 號 gate 保留；使用新退休流程須攜帶完整原 sources 並通过整組 oracle，不能只拿退休回執跳過 gate。候選持續 `recovery_required=1`、`releaseEligible=false`。

完整來源鏈／high-water、reset 後續世代與重複 epoch／exact key reuse、latest-erasure 私人歷史、外部 ancestry／custody、media／browser pending、真正停止來源 capture、正式規模、完整 TS bot／實際候選版本組合／B01–B15／QQ 及 audited activation 仍須完成。166 capabilities 維持 `in_progress`、0 accepted、`release_eligible=false`；不合入 `main`、不部署。
