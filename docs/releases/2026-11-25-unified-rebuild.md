# 统一版正式切换

2026-11-25 17:55（Asia/Taipei）启用正式新版；后续完成外网、bot 心跳、数据及备份检查。发布范围：`both`，统一原看板／成分网站并切换 TypeScript bot worker。以下为实际发布结果；本文后续提交只记录部署，范围 `none`，不重新建置或部署。

## 来源与版本

正式代码先合入 main 并双推 git.dan.tw／GitHub，两边 SHA 核对一致。完整来源 `54107b8a3c07444b1a3bd31188824bcfadaad4a8` 通过 `python3 deploy/check_release_source.py --commit ...` 后，以干净 archive 在本机建置一次 linux/amd64 映像；同一映像验证、传输、载入及运行，文件摘要独立核对。

| 服务 | 正式来源 | 实际映像 ID |
| --- | --- | --- |
| 新网站，含活动与音乐 | `54107b8a3c07444b1a3bd31188824bcfadaad4a8` | `sha256:2a7f4e9d9a9e1ed6cef6edc011ff366f0310f04509121c318d0abe891564c137` |
| 新 TypeScript bot | 同上 | 同上 |
| 已停止的旧看板 | `83eb54ce94f935a4048aaf63a410206723f09bd8` | `sha256:e26f55f0aa1c0a9d7d237d71fcf271bb52456a5f2a548f4679f3f5bd701920e9` |
| 已停止的旧成分站 | `be51e065bd0d64a2df3a783ca14672d92ba6d49a` | `sha256:2f066c1b478a4240b38fa45ee6a31337e9fc100fc8ca0400c9f7994718c66d0f` |
| 已停止的旧 Python bot | `07defc429d619a7558ab7218372886f531813ae3` | `sha256:e9d93c4441e2a34989722d7a5a86f87c8fa99cbc638b37cfe75a712fe6aa6720` |

修复正式映像缺少 Kimi CSS／按钮样式构建脚本的问题。映像验证工具增加明确的 release 目的，按 `origin-main` 核对版本，不修改或冒用 rehearsal 来源。

## 数据延续

最终维护窗停止旧 bot、web、music 及定时备份后，重新取得完整当前数据、身份、媒体、最新删除记录、历史与 bot 工作。没有将 5086 的可变测试副本提升为正式数据。

切换基线：53 帐号、16 活动、95 参加者、4 投票、153 词条、720 选择、130 outbox。`music_profiles` 共 75 列，含已删除记录，正式公开统计为 72 份有效成分；没有恢复已删除成分。独立 Python 核对原看板 59 张表的原列／rowid／值全部保留，原 117 笔已送工作保持状态及实际投递本文。导入器另外完成类型／完整性／外键和音乐映射对帐，同快照重跑返回 `already_imported`。

原看板没有删除 ledger，切换时 `privacy_requests=0`；明确记录缺失状态，并仅在擷取的辅助目录提供空基线。音乐原有最新删除 ledger 保留并应用。该事实保存在私人 ledger review，不在原服务目录伪造旧记录。

正式库为 `/var/lib/qgroup-unified/data/kanban.sqlite3`；原库及原成分目录保留不覆盖。独立权威位于 `/var/lib/qgroup-erasure`，固定检查点位于 `/var/lib/qgroup-checkpoint`。旧历史擷取在正式数据的 `legacy-capture` 中按固定 manifest 提供权限受控读取。

## 验证与实际切换

- 当前前端相关浏览器 25 项、发布补充单元 9 项、型别及编译产物 smoke 通过；此前全站及功能验收的来源／范围保留在原记录，不将它们称为本提交的一次完整重跑。
- 实际发布映像通过原生 SQLite／图片、静态原始 bytes、Service Worker、删除权威／锁／只读检查点、版本及正常停止检查。实际 bot 产物通过本机隔离 HTTP／WebSocket、ACK／Resume、未知／模拟投递、查询、缩写、排他所有权及 SIGTERM smoke。arm64 本机模拟 amd64 时，初次 512 MiB 跑批发生逾时／OOM；顺序执行并使用 1 GiB 的本机测试容量后通过，未放宽业务断言。正式两服务各限制 512 MiB、无额外 swap、1 CPU、128 PID。
- 同一正式映像读入原站隔离副本，保留权威与历史配置，通过实际启动、公开读取和正常停止。正式主机另在独立 18791 埠验证当前候选，仅启动独立副本网站，旧站继续提供服务；未启动测试 bot。
- 最终资料先在主机以 512 MiB 限额匯入／重跑对帐，将已停止来源及导入结果传到本机执行较耗记忆体的完整封存验证。返回的是核对过摘要的权威、固定检查点和私人封存；正式业务库保持在主机，返回前后原导入库 SHA 一致。
- 新网站先在 18791 埠完成读验证，再重建至原正式 8791 埠，随后启动唯一的新 worker。1Panel 反向代理与 TLS 未修改。新网站／bot 均 healthy、restart count 0；正式 bot 取得 gateway READY 与心跳 ACK，policy 和轮询正常。
- 外网 `/api/v2/version` 对应核准 SHA；新旧健康入口及活动／音乐／投票页面 200。浏览器实际查看正式活动列表、投票详情及 153 项音乐词库。未在正式库新增演示用户、活动或款项，没有人工试发 QQ 群消息或代用户完成真实 QQ 授权。

前两次维护尝试分别因完整封存超过主机 512 MiB 上限，以及部署辅助程序使用不受主机 Python 支持的解包参数而中止。两次均在公开新版写入前自动恢复原三服务；改为本机封存并先完成主机独立埠验证后，第三次切换成功。私人原始失败与成功日志均保留，没有以失败轮的副本直接上线。

## 备份、维运与恢复

保全目录 `/opt/qgroup-backups/unified-20261125-54107b8` 保存原配置／来源、每次停写的数据与历史快照、原版本及 ledger 事实。发布目录 `/opt/qgroup-releases/unified-20261125-54107b8` 保存核准来源、映像与摘要、捕获／导入／封存报告、有效配置和实际 runtime manifest；同一实际 manifest 写入 `/opt/qgroup/release-manifest.json`。私密原文、身份和凭证不进 Git。

当前 Compose 使用核准来源的 `deploy/unified-compose.yaml`，由发布目录 `runtime.env` 明确指定每服务的不可变映像、数据／权威／检查点目录及私有环境文件。实际解析配置通过 `checkRuntimeCompose`，验证资源、权限、共同数据、origin 和固定映像；这是显式配置检查，未宣称具备自动发布批准。

`qgroup-backup.service` 通过 systemd drop-in 改为新版备份适配，读取新库，输出到 `/var/backups/qgroup-unified`。保留数据库／图片配对，并在稳定副本上用原权威验证器核对删除记录和检查点，最后写入 `.complete.json`。首份完整备份成功，原定时器已恢复 active；新版网站另有每小时成套备份。原站备份不覆盖。辅助程序及配置的实际摘要保存在私人发布 manifest／证据中。

旧三容器已停止且 restart policy 为 `no`，旧应用 systemd 服务禁用，防止重开旧 writer／投递者；旧映像与数据仍保留。用户后续需要的可写旧版测试站尚未启动，必须使用独立副本并隔离真实 QQ 投递。

新版已开放写入，不能直接恢复停写旧库或启动旧服务作为回退。故障优先向前修复；必要时停止新写入，保存最新数据、最新删除权威及 bot 状态，以已验证的投影／对帐流程保留新业务再恢复旧程序。不可覆盖删除权威或重送已确认消息。
