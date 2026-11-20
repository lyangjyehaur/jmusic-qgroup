# 一般原生重置的來源範圍與離線恢復

日期：2026-11-21。變更範圍：`none`；修改離線驗證／恢復工具與測試。網站與 bot 運行程式、v2 journal／request／result、schema、outbox、設定與網址沒有修改。保留 Python bot，不合入 `main`，不部署。

第 158 號來源核對只接受沒有成分、沒有詞條的歷史重置。本次新增一般原生 reset 的固定來源驗證，接受原生／匯入、關聯／未關聯成分、詞條與全站歷史同時存在的來源，也接受只有詞條、沒有歷史的 reset。原 orphan-only 入口繼續保留原限制。

重置前來源的全部有效成分 ID／owner 與全部詞條 ID 必須精確等於原 v2 intent；不能以任意子集或不同 owner 當成同一個 reset。journal 前綴、唯一新增的完成 intent、原固定來源 hashes、schema、metadata、原回執、已套用標記與審計均須一致。管理記錄的成分／詞條數按真實原 scope 核對。

一般 reset 的私人資料準備明確共用現有 `replayMusicErasure` 服務邏輯，涵蓋認領／OAuth 證明、epoch、保存回應、匯入來源及私人欄位；詞條與 cascade 關係按既有 reset 語意處理。之後以獨立的全站歷史／authority row relation 核對完成副本的每一張表。這不會重播管理命令、生成替代回執或把工具的預期模型當成新的恢復來源。

`projectNativeForwardErasures` 新增可選的 `nativeResetSources`，在既有帳號／成分與詞條修復之後，修復已套用一般 reset 的原全站歷史。只有一個最新 reset 的明確來源可使用；同時提供多個世代、後續又有 reset、來源 rebase、同 key 的內容／provenance 改變，或新位置出現原 shout ID shadow，仍要求 ancestry，不按相同 key 或 bytes 推斷。兩種來源入口的 identity／bytes 都在輸出前再次核對。

修復只在持有 FK transaction 的記憶體候選執行。原留言、趨勢／來源文件、發布紀錄與相應 mappings 清除；新成分、新詞條、新留言與趨勢、一般網站登入、原回執、共享歷史及所有 bot 待送／投遞狀態保留。獨立完整 row oracle 驗證每張表、rowid、SQLite 儲存類型、內容與 metadata；候選仍 recovery-required。

**私人資料準備共用服務 writer，並非完全獨立的私人刪除 oracle。** 一般含成分的來源與修復報告明確標記 `profileProjectionUsesServiceWriter=true`、`fullPrivateScopeIndependentlyVerified=false`。Python 獨立程序核對的是全站歷史候選與全部保留 rows，不會因此把此旗標改為 true。停止 capture／外部 custody、完整 epoch／exact-key-reuse、多次 reset 與一般私人恢復仍待驗證；`allResetGenerationsReconciled=false`、`releaseEligible=false`。本次不是正式恢復或切換許可。

本機 **4 檔／109 個不同 unit／API 案例**通過，其中新檔 **20 個**與新增完整投影 **1 個**；與獨立 AST 展開的來源清單一致，最終全檔 run 沒有 skips。涵蓋完整 source／owner／term scope、完成副本的 claim／普通登入／保存回應／epoch 錯誤、只剩詞條的 cascade、同 ID／位置衝突、後續成分與共享 rows 保全、回執與 bot 狀態、完整投影重播、來源變動阻擋及 Python 逐表儲存比對。重複的定向邊界檢查包括在這 109 個內，不另計。

初次以原 orphan-only verifier 驗證真實一般 reset 的案例失敗，原報告保留。初次整合 run 為 2 passed／1 failed／其他未選案例 skipped：既有帳號恢復會把已註銷 bob 的隨機 token 改成確定的不可登入 marker，測試原先把 users 全表期待為不變。修正後逐欄比較 users，只允許該帳號的精確 marker；其餘 users、bot、財務、歷史与回執仍全 row 核對，未放寬生產邏輯。

strict、完整建置、built smoke、capability 規則檢查通過。相對第 158 號，**177 個 runtime source inputs、2 個 compiled API、9 個 compiled bot bundles**均相同；worker／全部 **85 個 precache resources**的整份 proof 相同。没有前台改動或新增展示文案。此提交的固定完整預期為 **171 檔／2,747 unit、81 檔／843 browser**，仍須原 CI 結果，相關案例不代替全量。

第 158 號原 run `44791726727` 的 image artifact `14655949071`／原 ZIP SHA `d60727b7930a6069ccde11eca6dff613dc21ff75bb24c08bade70afd3deaa542`已核對 metadata／CRC／全部解包 bytes、原終態 image job log、實際 Linux 雙映像、原 Python 55 blobs、三種合成投遞模式、原 worker／dispatch、85 HTTP／52 deep links 與清理，與本機 worker／static proof 完全相同。unit／browser 尚未終態，不能把 image 成功算成全 run 成功。第 157 號原 browser 已成功：原 ZIP `44889065dbe137b7d50c3dc5c2a65cd5647c9b267c5c2eda85397bb81853f3eb`的 metadata／CRC／97 個解包檔案全部核對，固定 **81 檔／843**案例沒有 skip／retry／flake；原 attachment 的 85 個 request／cache keys 與全部逐資源 bytes，以及原 development Python 報告的 55 blobs／177 compiled runtime inputs 核對通過。unit 仍在原 run 執行，不重啟原 job。

166 capabilities 仍為 0 fully accepted。完整 bot B01–B15／實際候選版本組合與 QQ、latest-erasure 私人歷史、media／browser pending、真正停止 capture、外部 ancestry／high-water／epochs、正式規模與 audited activation 仍待完成，整體重構目標保持未完成。
