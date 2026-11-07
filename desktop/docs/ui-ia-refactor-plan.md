# 桌面端向导与 IA 重构方案 v3.1 — 2026-11-05
（v3.1 终验修正：bootstrap 卡实为 8 张[漏 remote#417]；死 IPC 措辞精化；CSS 族口径修正）
（v1=文案级[判低] → v2=重造骨架 → v3=全量锚点+减法台账）

## 一、可用性分级（代码锚点实指）

| 产物 | 级别 | 锚点/证据 |
|---|---|---|
| 安装向导 GUI 链 | 🔴 | 盲点两次无效；成功记录全为 main 侧直驱；ENOENT(#138)/vendors(#139) 修后 GUI 零回归 |
| standalone 入口 | 🔴 死路 | app.js standaloneStart 调用点（初始化尾部块）：无 runtime→setStatusLine 报错文本，无引导 |
| 向导信息架构 | 🟡 | index.html L336-435：bootstrap overlay **8 卡**并列——hero(338)/status#345/mode#355/command#374/llm#377/log#402/quickstart#412/**remote#417(连接远程 controller，v3 漏计)**/components#427，无步骤主线 |
| boot gate | 🟡 | app.js:1228-1243；与 overlay 叙事断裂 |
| ✓pill | 🟡 | app.js:1246；功能在 |
| 死 IPC ×2 | 🟢 可删 | main.mjs handler + preload L8/9 暴露仍在，但 renderer 调用计数=0（在用 11 API 无此二者）——半死通道，删两层 |

## 二、视图全图（index.html 实测）

8 视图：mission(122)/planning(150)/tasks(164)/clarifications(188)/workspace(195)/reports(219)/teamauto(226)/controller(255)。
壳层：connection-card(44)/nav(82)/external-worker-install(120,hidden)/command-deck(304)/bootstrap-overlay 8 卡(336-435)/boot-screen。CSS 前缀族全量 ~20 族（assessment/brand/command/conversation 等，非仅昨日新块 8 族），均独立前缀解耦不变。
render 族（app.js）：tasks 详情 12 函数（2557-2699 时间线/tab/消息）、planning 8 函数（2717-2915）、teamauto 6 函数（1536-1722）、controller 设置 4 函数（1288/1758/1773/1811）+ 40+ upsert/applyLive 实时族（2337-2537）。

## 三、减法台账（勿叠功能的落地；净减 ≥ 新增）

| 项 | 处置 | 类型 |
|---|---|---|
| bootstrap 8 卡 | 重构为 3 步 Wizard：欢迎方式(1 卡；remote#417 即"连接现有"的现存载体，并入)/LLM(复用#377 字段)/进度(复用#402 log) | 合并 8→3 |
| bootstrap-command 卡#374 | 删除（Copy 进高级折叠） | 删 |
| quickstart#412 + components#427 两卡 | 并入进度步骤的阶段流（信息不丢，卡片消失） | 合并 2→0 |
| mode 卡#355 | 高级折叠（默认简洁模式） | 降级 |
| controller:install-local / openclaw:install-local IPC | 删除（main+preload+暴露面） | 删 ×2 |
| standalone 独立卡 | 并入 Wizard 产物 + 连接卡状态行 | 合并 |
| reports 视图 | 并入 tasks 详情（delivery=终态 tab） | 合并 |
| planning 视图 | 降级 mission 抽屉 | 降级 |
| external-worker-install 卡#120 | 保留（hidden 现状即低频，不动） | 保留 |
| **新增** isBundledRuntimeReady 门 | 替换 boot-gate/bootstrap/连接 三处分散判定（app.js:1228/1888/2053）的**合并物** | 换 3 为 1 |
| **新增** artifact 源 | 替换 gitlab 下载壳（ensureOpenClawRuntime 分支重构） | 换 1 为 1 |

净证明：删/合并 15 项（remote 并入步骤1 计入合并），新增 2 项（皆为既有判定/通道的替换合并）——**净减 13**。

## 四、向导（3 分钟路径）

步骤1 欢迎方式：私有实例[默认]/连接现有/高级(折叠:源[auto/bundled/artifact+sha256]/mode/CLI copy)
步骤2 LLM：provider+key+endpoint（现 #377 字段集）
步骤3 进度：阶段时间线 复用 bootstrap:install 事件流（#132）；完成→standaloneStart→自动连入
启动分派（唯一入口）：ready=就绪判定两查 → 直拉；未 ready → Wizard；连不上 → Wizard 步骤1 预选"连接现有"。

## 五、IA 与文案

mission 三段（等你处理=clarif+blocked[renderActivitySignals 2202 已有 blockedTaskCount]→进行中→团队态）；controller 视图改名"连接与实例"；ID 折叠 renderWorkerChip（role 并存证据 app.js:2673）；i18n 222 key 全表重审（双语表 L294-1262；新词：从这里开始/当前步骤/私有实例/临时演示链接）。

## 六、Bundled 完整化

就绪判定（离线两查：openclaw-state cfg models.providers[*].apiKey + plugins list 含 teamclaw）；artifact：release 产 teamclaw-runtime-<plat>.tar.gz（同构树+sha256）挂 GitHub Release；prepare-bundled.mjs + extraResources（bundle=内嵌离线树）。

## 七、迁移序（验收标准每步独立可跑）

S0 GUI 驱动器：AppleScript AX 菜单驱动 + 剧本骨架（全新机/缺插件/已就绪）。验收：三剧本 hermetic 全跑通且断言 DOM（非截图目测）
S1 Wizard 3 步 + 就绪门 + 删 2 死 IPC（main handler + preload 暴露两层）。验收：S0 剧本①③ 绿；grep install-local 于 main+preload=0；grep remote 卡 id 已并入步骤1
S2 standalone 并入 + 连接卡重整（boot gate/pill 叙事统一）。验收：剧本②（缺插件）绿；死路回归 V2（无 runtime 不再报错文本）
S3 IA：rail 8→6（reports/planning 降级）+ mission 三段 + ID 折叠。验收：导航枚举断言 + assignedWorkerId 直拼=0
S4 i18n 全表。验收：en/zh key 集合 diff=∅ + 新词抽查
S5 bundled 就绪+artifact+prepare-bundled。验收：离线剧本（断网）bundle 源 3 分钟路径全绿

## 八、风险与不做

不动后端/IPC 协议语义（只删死通道）；不加新功能能力；旧 i18n key 留一版 fallback；CSS 前缀内改（1604 行，前缀族全量 ~20 族均解耦，§二口径一致）；GUI 验证 AX 驱动不上 VM。

## 九、renderer 模块化拆分（S6，独立 PR，承接用户 2026-11-05 指示）

现状：app.js 4484 行单 IIFE。拆分原则：无行为变更，纯搬运+显式 import；每步 smoke+CDP 剧本回归。
i18n.js(双语字典+t) / state.js(state+实时族) / api.js(单一fetch面) / views/*(按视图) / wizard.js(本轮新代码) / app.js 入口<300行。
时机：SOT PR 合并后立即执行，不与功能变更混排。
