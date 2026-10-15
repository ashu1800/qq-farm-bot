# 奶茶热销中（2026110100）活动协议取证

> **v2.8.0 起本文档不再是实现依据**：奶茶活动已改为官方 v2.8.0 实现
> （`core/src/services/activity-milk-tea.js` + `core/src/proto/milk-tea.proto`
> + `core/src/activity-data/milk-tea-*.json`），本地早期版本（`activity.js` 内联实现与
> `admin-milk-tea-activity-routes.js`）已在合并上游 v2.8.0 时移除。本文档仅作历史取证留存。
>
> 取证时间：2026-10-15。取证方式：在线账号 `ActivityService.List` + `GetGroup(2026110100, "MilkTeaActivity")` 明文响应。
> 证据等级：结构表为 **在线明文（高）**；操作命令为 **同构复用推断（中）**，首次真实兑换/领取后应回填响应样本。

## 活动登记

| 项 | 值 |
| --- | --- |
| 组活动 ID | `2026110100`（type 1） |
| 子活动 | `2026110101`（type 22 规则）、`2026110102`（type 3 兑换商店）、`2026110103`（type 23 奶茶店主玩法）、`2026110104`（type 24 营业奖励） |
| 客户端入口 UID | `MilkTeaActivity`（来自 2026110101 的 payload 文本） |
| 营业期 | `1792029600`（2026-10-15 10:00 CST）— `1794844799`（2026-11-16 23:59:59 CST） |
| 官方说明 | 营业期 2026-10-15 — 11-14；结算期 11-15 — 11-16（停止营业/雇佣/宣传/购种，未完成班次按实际时长结算） |

## 子活动结构（GetGroup 明文）

- **2026110101**：纯规则节点，payload 含 `uid: "MilkTeaActivity"` 与活动说明文案（奶茶券用于购买种子、雇佣好友和兑换奖励；宣传喇叭立即获得 1 小时销售收益；收银台满载暂停营业）。
- **2026110102**：通用 `exchange_shop`（ActivityNode 字段 102），27 件商品，槽位 301–334。货币：`1001`（金币）、`1041`（奶茶券）、`1004`（未知货币，仅宣传喇叭条目 cost 使用）。代表性商品：
  - 种子：20525 森野甜莓 / 20526 白桃 / 20527 甜橙 / 20528 红柚 / 20021 可可豆 / 21435 柿子 / 20529 芭乐（金币 10000–20000）、29005 森野黄金芽（奶茶券 8000）、20522 金币果 / 20523 经验蘑菇（奶茶券 6000）
  - 装扮：311–323、331（围栏/仓库/木牌/栅栏/狗屋/街道/桌椅/门/窗/墙面/地板/屋顶/装饰套装/头像框，奶茶券 15000–100000）
  - 道具：333 化肥(1小时)（奶茶券 400）、334 有机化肥(1小时)（奶茶券 500）、332 宣传喇叭（item id 1042，cost 1004×8）
- **2026110103**：定制活动体。本地 activitypb 无对应字段，decoder 丢弃未知字段后节点仅剩 `activity`。按官方说明应为"我的奶茶店"（店名/收银台/热卖值/店铺升级/雇佣）。**字段号与命令未取证，未做任何操作实现。**
- **2026110104**：通用 `share_reward`（ActivityNode 字段 120），summary 与快乐不独享逐字段同构：`daily.claim_limit=3`、`my_pool.claim_limit=5`、`milestones`（threshold 10/20/30/60，奖励 80002 / 80013 / 1042×5 / 210048）、`daily_reward=5`、`first_share_reward=5`、`red_dots{daily,first_share}`。注意：summary 无 `current_score` 字段，营业额进度由服务端（推测在 2026110103 定制体）持有。

## 操作命令

| 动作 | 目标 ID | cmd | 请求体 | 证据 |
| --- | --- | --- | --- | --- |
| 兑换商品 | `2026110102` | `1` | `exchange_shop_operate { id: <槽位>, count }` | 通用结构，同雨落成诗（槽位 200）/星砂商店先例（高） |
| 领取每日奶茶收益 | `2026110104` | `73` | 空 | share_reward 体同构复用快乐不独享的"每日领取"（中） |
| 领取营业额档位 | `2026110104` | `70` | 空 | share_reward 体同构复用快乐不独享的"档位领取"（中） |
| 未实现：收银台/升级/雇佣/加工/宣传喇叭使用 | `2026110103` | 未知 | 未知 | 定制体，需抓包或官方客户端恢复 |

## 固定编码样本（core/test/milk-tea-activity.test.js）

```
{id:2026110102, cmd:1, exchange_shop_operate:{id:308, count:1}} => 0896f98fc6071001aa060508b4021001
{id:2026110104, cmd:73}                                          => 0898f98fc6071049
{id:2026110104, cmd:70}                                          => 0898f98fc6071046
```

## 已登记配置

- 物品名：`1041 奶茶券`、`1042 宣传喇叭`（`core/src/config/gameConfig.js` staticItemMap；1042 名称来自商店槽位 332 的服务端 `name` 字段）。
- 自动化开关：`milk_tea_daily`、`milk_tea_milestones`（`store.js` DEFAULT_AUTOMATION + `MILK_TEA_AUTOMATION_KEYS` + `TIMED_ACTIVITY_AUTOMATION_GROUPS`，与 `web/src/constants/activity-windows.ts` 的 `MILK_TEA_ACTIVITY_WINDOW` 双写同步）。

## 未完成与后续取证

1. **2026110103 定制体**：收银台余额、热卖值、店铺等级、雇佣信息全部在该体内。恢复路径：
   - 手机 Wi-Fi 代理指向本机 18000 端口（面板"系统配置 → Code/GID 抓取服务"开启后），在游戏内打开一次奶茶活动页并执行一次操作，用 `npm run inspect:activity-har` 解码响应；
   - 或在有 macOS QQ 官方客户端的机器上按 `$qq-farm-activity-protocol-recovery` skill 恢复。
2. **活动作物**：20525–20529、29005、20522、20523 等活动种子尚未登记 `core/src/gameConfig/EventPlants.json`——占地大小（size 字段）未经验证，按规范不得猜测；29000 系（如 29005）历史上为 2×2 作物家族，登记前必须先核实，否则会破坏 2×2 优先种植与土地预留流程。
3. **首次真实兑换/领取后**，应把 Operate 响应样本回填本文件并把"同构复用推断"升级为"在线明文"。
