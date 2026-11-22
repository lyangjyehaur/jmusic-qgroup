# 本機測試指南

本指南使用隔離資料及合成 QQ 登入。執行測試不會部署；目前線上網站與 bot 繼續使用原版本。

## 啟動可操作預覽

需要 Node 22.22.3 以上、npm 10.9.8 以上及 Python 3。於專案目錄執行：

```sh
npm ci --no-audit --no-fund
npm run build:rebuild
REBUILD_TEST_MUSIC_TREND=1 REBUILD_TEST_MUSIC_ROOMS=1 REBUILD_TEST_POLLS=1 REBUILD_TEST_FILE_STORAGE=1 node_modules/.bin/tsx apps/api/testsupport/preview.ts
```

開啟 <http://127.0.0.1:5082>。這組合提供合成會員、詞條、成分／趨勢、活動名冊及時間投票，並啟用暫存檔案庫以測試圖片上傳；預覽資料在停止程序後清除。不要將此程序連到正式資料庫。不要任意組合其他 `REBUILD_TEST_*` 參數：部分 fixture 使用相同會員、名冊或歷史版號。

一般登入直接按網站的 QQ 登入，會經本機模擬授權建立測試帳號，不需要真實 QQ。登入後可建立自己的成分、活動和投票。原成分找回可測合成編號 `10001`／PIN `123456`；這是測試資料。

若要操作樣本活動的發起者，於這個預覽頁的瀏覽器開發者工具 Console 執行以下測試 cookie，再重新整理：

```js
document.cookie = 'kanban_session=fixture-alice; Path=/; SameSite=Lax';
location.reload();
```

`fixture-bob` 是第二個合成帳號，可測不同帳號的參加、認領、權限拒絕與草稿隔離。`fixture-registration-admin` 可測帳號管理權限。此方式只適用上述本機測試 adapter，不用於正式登入。可用不同瀏覽器設定檔或無痕視窗分開兩個帳號。

## 建議操作順序

1. 匿名瀏覽活動；登入後開啟「我的成分」，搜尋及保存領域／細分選擇，確認未保存離頁和重新整理恢復。再從同好、詞條、圈子及全站搜尋往返，確認使用同一份選擇和帳號。
2. 建立活動並發布；第二個帳號報名，發起者代報沒有成分的同行。核對名冊、認領、候補、出席及安排更新；另測時間投票與定案活動。
3. 從活動進入成分分房工具，計算有成分者並人工安排其他同行；確認後採用正式房間。第二個帳號應無法代發起者採用。
4. 活動開始／結束後依實際名冊結算，核對逐人／付款人金額、圖片及歷史版次；再測帳本申報、確認、退款、收件匣及待辦。
5. 在「本機紀錄」檢查草稿／待確認操作；測離線、刷新、丟失回應、切帳號及精確重試，確認原稿可保全且已提交操作不重送。管理入口另外測詞庫、身份限制及 bot 設定；本機預覽沒有投遞程序。

`/tools/room-lab` 的活動分房建議與正式分房是兩個確認步驟；沒有成分者保留在完整名冊，可人工安排，不參加自動音樂計算。收款碼／帳務只用合成圖片和金額。

## 開發與自動驗證

要修改程式可執行 `npm run dev:rebuild`；前端 <http://127.0.0.1:5080>、API <http://127.0.0.1:5081>，使用獨立 `.rebuild-data` 開發庫，不載入上述預覽 fixture 或合成 QQ adapter。

```sh
npm run check:capabilities
npm run build:rebuild
npm run test:build:rebuild
npm run test:rebuild -- --maxWorkers=1 --testTimeout=30000
npm run test:e2e:rebuild -- --forbid-only
REBUILD_RETAINED_PYTHON_COMMIT=07defc429d619a7558ab7218372886f531813ae3 npm run test:retained-python:rebuild
```

單元完整回歸會啟動 Python 原行為讀取器；建議單一 worker。瀏覽器回歸自行管理 5082 端口，執行前先停止手動預覽，且先建置。macOS 有 Chrome 時預設使用 Chrome；其他環境先執行 `npx playwright install chromium`。bot 測試使用固定線上來源和受控投遞，不需要正式憑證。

完整 Linux CI 提交 `03d364f89b647315f4b8728f7c264610398d076b` 的 unit 4,063 項、browser 1,044 項及映像組合均通過，沒有略過或重試。第 221 批手機工具及第 222 批兩項管理登出測試另有本機驗證；不將未包含的修改套用原完整 CI。真正匯出的線上 bot 映像隔離組合及同一正式副本的匯入／回退證據見[第 219 批](219-current-copy-and-acceptance-checkpoint.md)。

目前 10 個既有功能父項本機通過；156 個及 U01–U03 仍待完整審核，另須完成經審核 recovery activation 與固定原 web／music／bot 的成套回退操作。找搭子原資料、管理刪除、PWA、壁紙及跨裝置管理登出的最新證據見[第 222 批](222-shouts-pwa-and-admin-parent-acceptance.md)。本機預覽可立即操作，最終 P6 驗收尚未完成。真實 QQ／WebView 的平台結果分開記錄；本輪不部署。
