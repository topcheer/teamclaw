-- 跨境电商 ERP 数据库初始化脚本
-- 支持 PostgreSQL

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 订单表
CREATE TABLE IF NOT EXISTS orders (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  platform      VARCHAR(20) NOT NULL,          -- amazon | shopify | tiktok_shop
  platform_order_id VARCHAR(100) NOT NULL,
  store_id      VARCHAR(100) NOT NULL,
  status        VARCHAR(20) NOT NULL DEFAULT 'pending',
  total_amount  DECIMAL(15, 2) NOT NULL,
  currency      VARCHAR(3) NOT NULL,           -- USD | CNY | EUR | JPY
  line_items    JSONB NOT NULL,
  shipping_address JSONB NOT NULL,
  customer_email VARCHAR(255),
  customer_note TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 库存表
CREATE TABLE IF NOT EXISTS inventory (
  sku               VARCHAR(100) PRIMARY KEY,
  product_name      VARCHAR(255) NOT NULL,
  quantity          INTEGER NOT NULL DEFAULT 0,
  reserved_quantity INTEGER NOT NULL DEFAULT 0,
  available_quantity INTEGER NOT NULL DEFAULT 0,
  platform_quantities JSONB DEFAULT '{}',      -- {"amazon": 50, "shopify": 30, ...}
  last_sync_at      TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_orders_platform ON orders(platform);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders(created_at);
CREATE INDEX IF NOT EXISTS idx_orders_platform_order_id ON orders(platform, platform_order_id);
CREATE INDEX IF NOT EXISTS idx_inventory_available ON inventory(available_quantity);
