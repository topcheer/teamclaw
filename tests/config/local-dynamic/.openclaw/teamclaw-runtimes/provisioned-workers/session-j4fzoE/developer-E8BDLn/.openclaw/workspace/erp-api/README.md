# ERP API — Cross-border E-commerce ERP System

## Core API Modules

### Order Management (`/api/orders`)

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/orders` | Create order (multi-platform source, item details, shipping address) |
| `GET` | `/api/orders/:id` | Get order details |
| `GET` | `/api/orders` | List orders (filter by platform, status, date range; paginated) |
| `PUT` | `/api/orders/:id/status` | Update order status (state machine enforced) |

### Inventory Sync (`/api/inventory`)

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/inventory/sync` | Trigger multi-platform inventory sync (distributed lock) |
| `GET` | `/api/inventory/:sku` | Query SKU inventory across all platforms |
| `PUT` | `/api/inventory/:sku?platform=...` | Update inventory quantity (distributed lock, negative guard) |

## Key Design Decisions

- **State machine** for order status transitions (no invalid jumps)
- **Redis distributed locks** on inventory writes to prevent overselling
- **Zod schemas** for request validation on all endpoints
- **Platform adapter pattern** via `fetchPlatformInventory()` — swap per-platform SDK calls
- **Currency-aware**: multi-currency support (USD/CNY/EUR/JPY) with platform fee calculation
- **PostgreSQL JSONB** for flexible item/address storage
- **Graceful shutdown** on SIGTERM

## Directory Structure

```
erp-api/
├── src/
│   ├── config/
│   │   ├── database.ts      # PostgreSQL connection pool
│   │   └── redis.ts         # Redis client + distributed lock helpers
│   ├── middleware/
│   │   ├── errorHandler.ts  # Global error handler
│   │   └── validate.ts      # Zod request validation middleware
│   ├── routes/
│   │   ├── orders.ts        # Order CRUD endpoints
│   │   └── inventory.ts     # Inventory query + sync endpoints
│   ├── services/
│   │   ├── order.service.ts # Order business logic
│   │   └── inventory.service.ts # Inventory sync + lock logic
│   ├── types/
│   │   └── index.ts         # All TypeScript interfaces
│   └── index.ts             # Express app entry point
├── migrations/
│   └── 001_init.sql         # Database schema
├── package.json
└── tsconfig.json
```

## Quick Start

```bash
cd erp-api
npm install
# Set DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD, REDIS_URL
npx ts-node src/index.ts
```
