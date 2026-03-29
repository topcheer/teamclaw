# 跨境电商 ERP — 后端 API 服务

## 技术栈
- **Node.js + Express + TypeScript**
- **PostgreSQL** — 主数据库
- **Redis** — 缓存（预留）

## 项目结构

```
src/
├── config/
│   ├── database.ts      # PostgreSQL 连接池
│   └── utils.ts         # ID 生成、时间工具
├── middleware/
│   └── errorHandler.ts   # 全局错误处理 + 请求校验
├── types/
│   └── index.ts          # 所有类型定义（DTO、枚举、接口）
├── routes/
│   ├── orders.ts         # 订单管理路由
│   └── inventory.ts      # 库存同步路由
├── services/
│   ├── orderService.ts   # 订单业务逻辑
│   └── inventoryService.ts  # 库存同步 + 分布式锁
└── index.ts              # 应用入口
```

## API 接口

### 订单管理 (`/api/orders`)

| 方法 | 路径 | 说明 |
|------|------|------|
| `POST` | `/api/orders` | 创建订单 |
| `GET` | `/api/orders/:id` | 获取订单详情 |
| `GET` | `/api/orders` | 订单列表（筛选：platform, status, startDate, endDate, page, pageSize） |
| `PUT` | `/api/orders/:id/status` | 更新订单状态（含状态机校验） |

### 库存同步 (`/api/inventory`)

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/inventory/sync` | 触发多平台库存同步（可选 ?sku=） |
| `GET` | `/api/inventory/:sku` | 查询 SKU 库存详情 |
| `PUT` | `/api/inventory/:sku` | 更新库存数量（带分布式锁） |

## 核心设计

### 订单状态机
```
pending → confirmed → processing → shipped → delivered
   ↓         ↓          ↓           ↓
cancelled cancelled cancelled    refunded
```

### 库存同步
- **分布式锁**：使用 PostgreSQL advisory lock (`pg_advisory_lock`) 防止并发超卖
- **平台适配器**：统一 `PlatformAdapter` 接口，各平台独立实现
- **负数保护**：数据库 `CHECK (quantity >= 0)` 约束 + 应用层校验

## 启动

```bash
# 设置环境变量
export DATABASE_URL=postgresql://postgres:postgres@localhost:5432/erp
export PORT=3000

# 安装依赖
npm install

# 编译 & 启动
npx tsc && node dist/index.js
# 或开发模式
npx ts-node-dev src/index.ts
```
