# 需求：房产经纪 SaaS 平台 (Real Estate Broker Platform)

## 项目概述
开发一个面向房产中介公司的 SaaS 平台后端，包含房源管理、客户 CRM、带看房日程、佣金结算和数据分析模块。这是一个多模块业务系统，需要合理的数据模型和业务流程。

## 核心模块

### 1. 房源管理 (Property)
- 房源 CRUD：标题、小区名、地址、户型（室/厅/卫/面积）、总价、单价
- 房源状态流转：`new` → `listed` → `showing` → `negotiating` → `sold` / `expired`
- 图片管理：每套房最多 20 张图片，支持封面设置和排序
- 房源标签系统：学区房、地铁房、精装修、满五唯一等

### 2. 客户 CRM
- 客户信息：姓名、电话、预算范围、意向区域、意向户型
- 客户来源追踪：线上/线下/转介绍
- 跟进记录：每次联系的客户动态
- 客户-房源关联：收藏、带看、出价

### 3. 带看日程
- 日历视图：按经纪人展示每日带看安排
- 带看单：关联经纪人、客户、多套房源、时间路线
- 带看反馈：客户对每套房的评分和评价
- 冲突检测：同一时间段同一经纪人不可重叠

### 4. 佣金结算
- 交易达成后自动生成佣金单
- 佣金分成：成交经纪人 60%、房源录入人 20%、店长 20%
- 提成状态：`pending` → `approved` → `paid` → `disputed`
- 月度汇总报表

### 5. 数据看板 API
- 月度成交量、成交额趋势
- 经纪人业绩排行
- 区域热门小区统计
- 房源平均挂牌周期

## 技术要求
- 使用 Python + FastAPI
- SQLAlchemy ORM + SQLite（单文件 app.py，models 内联）
- Pydantic 请求/响应模型
- JWT 简单认证（login 获取 token）
- 至少 15 个 API 端点
- 自带 20 条房源种子数据和 10 个客户种子数据

## 数据模型
```
Property: id, title, community, address, rooms(室/厅/卫), area, total_price, unit_price, status, tags[], images[], agent_id, created_at, updated_at
Customer: id, name, phone, budget_min, budget_max, preferred_areas[], source, agent_id, notes, created_at
Showing: id, agent_id, customer_id, property_ids[], scheduled_at, status, feedbacks{}, created_at
Commission: id, property_id, agent_id, listing_agent_id, manager_id, total_amount, splits[], status, transaction_date
```

## 交付标准
- `uvicorn app:app --port 8000` 启动后所有端点可用
- 种子数据可通过 `/api/v1/seed` 初始化
- `/docs` 展示完整 API 文档
- 带看冲突检测和佣金计算逻辑正常工作
