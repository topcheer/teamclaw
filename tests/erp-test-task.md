# 跨境电商 ERP 系统 — 多角色协同开发任务

## 项目背景
开发一套跨境电商 ERP 系统，支持多平台（Amazon、Shopify、TikTok Shop）订单管理、库存同步、物流追踪、财务对账等功能。

## 技术栈
- 前端：React 18 + TypeScript + Ant Design Pro
- 后端：Node.js + Express + TypeScript
- 数据库：PostgreSQL + Redis
- 部署：Docker Compose

## 开发任务（按角色分工）

### Developer 任务
设计并实现以下核心 API 模块：
1. **订单管理 API**（`/api/orders`）
   - `POST /api/orders` — 创建订单（包含多平台来源、商品明细、收货地址）
   - `GET /api/orders/:id` — 获取订单详情
   - `GET /api/orders` — 订单列表（支持按平台、状态、时间范围筛选）
   - `PUT /api/orders/:id/status` — 更新订单状态
2. **库存同步 API**（`/api/inventory`）
   - `GET /api/inventory/sync` — 触发多平台库存同步
   - `GET /api/inventory/:sku` — 查询 SKU 库存
   - `PUT /api/inventory/:sku` — 更新库存数量

### QA 任务
为上述 API 编写完整的测试方案：
1. 订单 API 测试用例（正常流程 + 边界 + 异常）
2. 库存同步测试用例（并发同步冲突、库存为负数保护）
3. 多语言货币金额处理测试（USD/CNY/EUR/JPY）
4. 数据一致性测试（跨平台库存同步后的一致性验证）

### Architect 任务
设计系统架构：
1. 多平台订单聚合架构（统一数据模型 + 平台适配器模式）
2. 库存同步的分布式锁方案（防止超卖）
3. 系统模块划分和接口规范
4. 数据库 ER 图设计

## 交付要求
- 每个角色在自己的 workspace 目录下完成工作
- 代码使用 TypeScript，类型定义完整
- API 接口遵循 RESTful 规范
- 所有代码文件以 `.ts` 或 `.tsx` 扩展名保存
