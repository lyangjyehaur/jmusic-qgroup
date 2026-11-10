#!/usr/bin/env python3
"""QQ Bot 一次性連通性探測（查證依據：bot.qq.com API v2 文件，2026-11-10）。

這支程式不是 qgroup 服務的一部分：不 import qgroup_core、不碰 SQLite、
不進 server2 部署清單、不需要公網 IP / 域名 / HTTPS / 1Panel。
官方 WebSocket 方式本機跑即可：「不依賴公網伺服器部署，適合個人單機使用」。

測試前請先完成三件事，否則結果會被誤判：
  1. 機器人已加進你是群主「或管理員」的群（手機 QQ 最新版，官方新版指南兩者皆可）。
  2. 開「主動推送」開關——注意不是 bot 個人資料頁的開關，是「群內權限」：
     手機 QQ -> 群成員列表「機器人」分組 -> 點該 bot -> 資料卡右上齒輪 ->
       a. 「機器人可獲取的群聊消息範圍」設為「獲取群內全部消息」
       b. 開啟「機器人主動在群聊內發言」
     或：群聊右上 -> 聊天資訊 -> 「群機器人」-> 該 bot 的「管理」。
     官方 2026-06-24「QQ 機器人進群能力升級」公告三項權限都寫「當群主設定」，
     該公告底下也有開發者回覆「必須是群主」、以及「開了開關但 socket 測主動仍失敗」。
     所以若你是管理員，請群主本人操作一次；沒開會得到 40034105。
  3. 開發基礎設定 -> 消息 URL 白名單，報備下面 TEST_URL 的網域並完成根目錄校驗檔。
     未報備時含 URL 的訊息會回 40054010，那是設定問題，不是「連結被過濾」。

執行：
  python3 -m venv .venv-botprobe && . .venv-botprobe/bin/activate
  pip install websockets
  export QQBOT_APP_ID=... QQBOT_APP_SECRET=...
  python3 tools/qq_bot_probe.py
  # 可選：QQBOT_SANDBOX=1（bot 未上線時只能連沙箱）、QQBOT_TEST_URL=https://你的域名/

然後在群裡 @ 機器人發一句話。程式會印出原始事件，並自動測四種發訊息方式
（每 @ 一輪重測一次、8 秒節流，改完手機開關可直接再 @ 不用重跑）。

`QQBOT_TIMER_GROUP=<group_openid>` + `QQBOT_TIMER_DELAY=20`：READY 後自動發兩則
純主動訊息（純文字、含 URL），全程不需要任何 @ 事件。這是在驗證日後
`bot_outbox` 消費端最關鍵的一條路徑；發送前會印出累計事件數供對照。

事件白名單必須同時涵蓋 `GROUP_AT_MESSAGE_CREATE` 與 `GROUP_MESSAGE_CREATE`：
開啟「獲取群內全部消息」後，@ 訊息會改以 `GROUP_MESSAGE_CREATE` 推送，且
`mentions[].is_you` 才是判斷是否被 @ 的依據（事件類型本身不再保證）。
只監聽 AT 事件會誤判成「@ 了沒反應」。
Ctrl-C 結束。AppSecret 只從環境變數讀，不寫入任何檔案或日誌。
"""

import asyncio
import json
import os
import sys
import urllib.error
import urllib.request

try:
    from websockets.asyncio.client import connect as ws_connect
except ImportError:
    try:
        from websockets import connect as ws_connect
    except ImportError:
        print("缺少依賴：請先執行 pip install websockets", file=sys.stderr)
        raise SystemExit(2)

ENV_FILE = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), ".bot-probe.env")


def load_env_file(path):
    """只解析 KEY=VALUE，不執行任何內容；已存在的環境變數優先。"""
    try:
        with open(path, encoding="utf-8") as handle:
            for line in handle:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, value = line.split("=", 1)
                key = key.strip()
                if key.startswith("QQBOT_") and key not in os.environ:
                    os.environ[key] = value.strip().strip('"').strip("'")
    except FileNotFoundError:
        pass


load_env_file(ENV_FILE)

APP_ID = os.environ.get("QQBOT_APP_ID", "").strip()
APP_SECRET = os.environ.get("QQBOT_APP_SECRET", "").strip()
SANDBOX = os.environ.get("QQBOT_SANDBOX") == "1"
TEST_URL = os.environ.get("QQBOT_TEST_URL", "https://kanban.danndann.cn/").strip()
# 純定時推播測試：直接指定 group_openid，連線後不需要任何事件就能發。
TIMER_GROUP = os.environ.get("QQBOT_TIMER_GROUP", "").strip()
try:
    TIMER_DELAY = float(os.environ.get("QQBOT_TIMER_DELAY", "20"))
except ValueError:
    TIMER_DELAY = 20.0

# 官方文件寫 api.bot.qq.com，多數實測文件寫 bots.qq.com，兩邊都試。
TOKEN_HOSTS = ("https://bots.qq.com", "https://api.bot.qq.com")
API_BASE = "https://sandbox.api.sgroup.qq.com" if SANDBOX else "https://api.sgroup.qq.com"
FALLBACK_WSS = "wss://api.bot.qq.com/websocket/"
INTENTS = 1 << 25  # GROUP_AND_C2C_EVENT：群 @ 訊息 + 單聊

ERROR_HINT = {
    40034105: ("無主動訊息權限（官方建議「請檢查機器人權限設置」）："
               "① 群主本人到「群內 bot 權限頁」開『機器人主動在群聊內發言』＋設『獲取群內全部消息』"
               "（管理員開的可能不生效，官方公告寫「當群主設定」）；"
               "② bot 未上線／仍在沙箱；③ 平台尚未對該 bot 灰度開放主動推送"),
    40034100: "主動訊息超過頻控（60/30 qpm、單關係 20 qpm、每群每天 1000 條）",
    40034101: "機器人不是群成員，先拉進群",
    40054003: "機器人不是群成員，先拉進群",
    40054010: "不允許發送 URL：消息 URL 白名單未報備該網域",
    40034005: "msg_id 已過期（被動回覆 5 分鐘內有效）",
    40034128: "被動回覆時間或次數超限（每則最多 5 次）",
    40054005: "訊息被去重，msg_seq 要遞增",
    40054007: "訊息長度超限",
    40054016: "機器人已下線",
    304061: "訊息內容無效",
    50055001: "平台側異常，稍後重試",
}


def http_json(method, url, payload=None, headers=None):
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    for key, value in (headers or {}).items():
        req.add_header(key, value)
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            raw = resp.read().decode("utf-8") or "{}"
            return resp.status, json.loads(raw)
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8") or "{}"
        try:
            return exc.code, json.loads(raw)
        except json.JSONDecodeError:
            return exc.code, {"raw": raw[:300]}


def get_token():
    body = {"appId": APP_ID, "clientSecret": APP_SECRET}
    last = ""
    for host in TOKEN_HOSTS:
        try:
            status, data = http_json("POST", host + "/app/getAppAccessToken", body)
        except Exception as exc:
            last = "%s: %s" % (host, exc)
            continue
        # 官方：業務錯誤也回 HTTP 200，要看 body 的 code，不能只看狀態碼。
        if isinstance(data, dict) and data.get("access_token"):
            print("[token] %s OK, expires_in=%s" % (host, data.get("expires_in")))
            return data["access_token"]
        last = "%s: HTTP %s %s" % (host, status, data)
    raise RuntimeError("取得 access_token 失敗：%s（檢查 AppID / AppSecret / bot 是否已上線）" % last)


def get_gateway(token):
    headers = {"Authorization": "QQBot %s" % token}
    try:
        status, data = http_json("GET", API_BASE + "/gateway", None, headers)
        if isinstance(data, dict) and data.get("url"):
            print("[gateway] %s" % data["url"])
            return data["url"]
        print("[gateway] HTTP %s %s" % (status, data))
    except Exception as exc:
        print("[gateway] 取得失敗：%s" % exc)
    print("[gateway] 改用官方文件預設接入點 %s" % FALLBACK_WSS)
    return FALLBACK_WSS


def send_group(token, group_openid, label, payload):
    url = "%s/v2/groups/%s/messages" % (API_BASE, group_openid)
    try:
        status, data = http_json("POST", url, payload, {"Authorization": "QQBot %s" % token})
    except Exception as exc:
        print("  [%s] 請求失敗：%s" % (label, exc))
        return False
    code = data.get("code") if isinstance(data, dict) else None
    hint = ERROR_HINT.get(code, "")
    print("  [%s] HTTP %s code=%s %s" % (label, status, code, hint))
    print("    response=%s" % json.dumps(data, ensure_ascii=False)[:400])
    return status < 300 and code in (None, 0)


async def run_send_probes(token, group_openid, msg_id):
    print("[probe] group_openid=%s... 開始四項發訊息測試" % str(group_openid)[:10])
    # 1. 被動回覆：帶 msg_id，5 分鐘內有效、每則最多 5 次
    if msg_id:
        await asyncio.to_thread(send_group, token, group_openid, "1 被動回覆 純文字", {
            "msg_type": 0, "content": "[probe] 被動回覆 OK",
            "msg_id": msg_id, "msg_seq": 1,
        })
    else:
        print("  [1 被動回覆 純文字] 事件沒有 d.id，跳過")
    # 2. 主動訊息：不帶 msg_id，需要主動推送權限
    await asyncio.to_thread(send_group, token, group_openid, "2 主動訊息 純文字", {
        "msg_type": 0, "content": "[probe] 主動訊息 OK",
    })
    # 3. 主動訊息 + URL：對照第 2 項，即可區分「無主動權限」與「URL 未報備」
    await asyncio.to_thread(send_group, token, group_openid, "3 主動訊息 含URL", {
        "msg_type": 0, "content": "[probe] 連結測試 %s" % TEST_URL,
    })
    # 4. 被動回覆第二則（同 msg_id、不同 msg_seq）：驗證被動池可連發。
    #    若主動推送始終不通，bot 就只能設計成「使用者 @ 之後連發多則」的降級模式。
    if msg_id:
        await asyncio.to_thread(send_group, token, group_openid, "4 被動回覆 第二則", {
            "msg_type": 0, "content": "[probe] 被動第二則 OK（降級模式可用）",
            "msg_id": msg_id, "msg_seq": 2,
        })
    print("[probe] 結束。1 成功=事件與被動鏈路通；2 成功=可主動推播；"
          "2 成功但 3 失敗=URL 白名單；2 就失敗 40034105=權限／上線狀態；"
          "4 成功=即使主動不通，仍可在同一次 @ 後連發多則（被動池降級可用）。")


async def timer_probe(token, state):
    """驗證 bot_outbox 的核心路徑：沒有任何 @ 事件、不帶 msg_id 也能主動發訊息。"""
    await asyncio.sleep(max(TIMER_DELAY, 3))
    print("[timer] === 純定時主動推播（不帶 msg_id、不依賴任何事件）===")
    print("[timer] 發送前收到的群事件數 = %s；target group=%s..." % (
        state.get("event_count", 0), TIMER_GROUP[:10]))
    await asyncio.to_thread(send_group, token, TIMER_GROUP, "T1 定時主動 純文字", {
        "msg_type": 0, "content": "[probe] 定時主動推播 OK（不需任何人 @）",
    })
    await asyncio.to_thread(send_group, token, TIMER_GROUP, "T2 定時主動 含URL", {
        "msg_type": 0, "content": "[probe] 定時連結測試 %s" % TEST_URL,
    })
    print("[timer] 結束。兩則 200 = 未有任何 @ 也能主動發，bot_outbox 核心路徑成立。")


async def main_async():
    token = await asyncio.to_thread(get_token)
    auth = "QQBot %s" % token
    ws_url = await asyncio.to_thread(get_gateway, token)
    state = {"s": None, "probed": False, "hb": None}

    async with ws_connect(ws_url, open_timeout=20, ping_interval=None) as ws:
        print("[ws] 已連線，等待 Hello")
        async for raw in ws:
            msg = json.loads(raw)
            op = msg.get("op")
            if msg.get("s") is not None:
                state["s"] = msg["s"]

            if op == 10:
                interval = msg.get("d", {}).get("heartbeat_interval", 45000)
                print("[ws] Hello, heartbeat_interval=%sms" % interval)
                await ws.send(json.dumps({
                    "op": 2,
                    "d": {
                        "token": auth,
                        "intents": INTENTS,
                        "shard": [0, 1],
                        "properties": {"$os": "macos", "$browser": "qgroup-probe", "$device": "qgroup-probe"},
                    },
                }))
                print("[ws] 已送出 Identify (intents=%s)。現在去群裡 @ 機器人發一句話。" % INTENTS)

                async def beat():
                    while True:
                        await asyncio.sleep(max(interval / 1000 * 0.9, 1))
                        await ws.send(json.dumps({"op": 1, "d": state["s"]}))

                state["hb"] = asyncio.create_task(beat())

            elif op == 11:
                pass  # Heartbeat ACK

            elif op == 0:
                event_type = msg.get("t")
                payload = msg.get("d") or {}
                if event_type == "READY":
                    print("[ws] READY，session_id=%s" % payload.get("session_id"))
                    if TIMER_GROUP and not state.get("timer_started"):
                        state["timer_started"] = True
                        print("[timer] 已排程，%s 秒後自動發送（這段時間請不要發訊息）" % TIMER_DELAY)
                        asyncio.create_task(timer_probe(token, state))
                else:
                    state["event_count"] = state.get("event_count", 0) + 1
                print("[event] t=%s s=%s d=%s" % (
                    event_type, state["s"], json.dumps(payload, ensure_ascii=False)[:700]))
                # 開了「獲取群內全部消息」後，@ 訊息改以 GROUP_MESSAGE_CREATE 推送，
                # 且同一則可能同時推 AT 與全量兩種事件；不能只監聽 GROUP_AT_MESSAGE_CREATE。
                # 官方 intents 1<<25 (GROUP_AND_C2C_EVENT) 已涵蓋兩者，實測可收到。
                if event_type in (
                    "GROUP_AT_MESSAGE_CREATE", "GROUP_MESSAGE_CREATE", "GROUP_MSG_RECEIVE"
                ):
                    group_openid = payload.get("group_openid")
                    author = payload.get("author") or {}
                    if author.get("bot"):
                        print("[skip] 機器人自己發的訊息，略過以避免自回聲")
                        continue
                    if event_type == "GROUP_MESSAGE_CREATE":
                        # 全量事件不保證有 @，是否 @ 本 bot 只能讀 mentions[].is_you。
                        if not any(m.get("is_you") for m in (payload.get("mentions") or [])):
                            print("[skip] 全量訊息未 @ 本 bot，略過")
                            continue
                        print("[ok] 全量模式下收到 @ 本 bot 的訊息（mentions.is_you=true）")
                    now = asyncio.get_running_loop().time()
                    # 可重複觸發：開完權限後再 @ 一次即可重測，8 秒節流避免刷屏。
                    if group_openid and now - state.get("last_probe", -100.0) > 8:
                        state["last_probe"] = now
                        state["round"] = state.get("round", 0) + 1
                        print("[ok] 第 %s 輪：收到群事件，@ 事件鏈路是通的" % state["round"])
                        await run_send_probes(token, group_openid, payload.get("id"))

            elif op == 9:
                print("[ws] Invalid Session，需重新 Identify（請重跑本程式）")
            else:
                print("[ws] op=%s %s" % (op, json.dumps(msg, ensure_ascii=False)[:300]))

    if state["hb"]:
        state["hb"].cancel()


def main():
    if not APP_ID or not APP_SECRET:
        print("請先設定 QQBOT_APP_ID 與 QQBOT_APP_SECRET 環境變數", file=sys.stderr)
        return 2
    print("[cfg] app_id=%s**** sandbox=%s api=%s" % (APP_ID[:4], SANDBOX, API_BASE))
    print("[cfg] test_url=%s" % TEST_URL)
    try:
        asyncio.run(main_async())
    except KeyboardInterrupt:
        print("\n[done] 已結束（Ctrl-C）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
