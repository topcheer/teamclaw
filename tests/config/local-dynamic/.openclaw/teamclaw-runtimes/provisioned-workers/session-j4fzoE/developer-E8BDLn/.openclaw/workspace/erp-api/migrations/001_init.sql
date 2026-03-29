-- SQL Schema for Cross-border E-commerce ERP System
-- Database: PostgreSQL

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 订单表
CREATE TABLE IF NOT EXISTS orders (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  platform_order_id VARCHAR(255) NOT NULL,
  platform VARCHAR(50) NOT NULL CHECK (platform IN ('amazon', 'shopify', 'tiktok_shop')),
  status VARCHAR(50) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'confirmed', 'processing', 'shipped', 'delivered', 'cancelled', 'refunded')),
  items JSONB NOT NULL,
  shipping_address JSONB NOT NULL,
  customer_email VARCHAR(255),
  currency VARCHAR(3) NOT NULL CHECK (currency IN ('USD', 'CNY', 'EUR', 'JPY')),
  total_amount DECIMAL(12, 2) NOT NULL,
  platform_fee DECIMAL(12, 2) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (platform_order_id, platform)
);

CREATE INDEX idx_orders_platform ON orders (platform);
CREATE INDEX idx_orders_status ON orders (status);
CREATE INDEX idx_orders_created_at ON orders (created_at);
CREATE INDEX idx_orders_platform_status ON orders (platform, status);

-- 库存表
CREATE TABLE IF NOT EXISTS inventory (
  sku VARCHAR(255) NOT NULL,
  platform VARCHAR(50) NOT NULL CHECK (platform IN ('amazon', 'shopify', 'tiktok_shop')),
  available INTEGER NOT NULL DEFAULT 0,
  reserved INTEGER NOT NULL DEFAULT 0,
  warehouse_code VARCHAR(100) NOT NULL DEFAULT 'DEFAULT',
  last_synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  PRIMARY KEY (sku, platform)
);

CREATE INDEX idx_inventory_sku ON inventory (sku);
CREATE INDEX idx_inventory_platform ON inventory (platform);
CREATE INDEX idx_inventory_last_synced ON inventory (last_synced_at);

-- 触发器：自动更新 updated_at
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS orders_updated_at ON orders;
CREATE TRIGGER orders_updated_at
  BEFORE UPDATE ON orders
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
