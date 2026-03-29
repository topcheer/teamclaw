import { db } from '../config/database';
import {
  Order,
  CreateOrderDTO,
  UpdateOrderStatusDTO,
  OrderStatus,
  OrderListQuery,
  PaginatedResult,
  AppError,
  Platform,
  OrderItem,
} from '../types';

// ---- SQL helpers ----

const mapRowToOrder = (row: Record<string, unknown>): Order => ({
  id: row.id as string,
  platformOrderId: row.platform_order_id as string,
  platform: row.platform as Platform,
  items: JSON.parse(row.items as string) as OrderItem[],
  shippingAddress: JSON.parse(row.shipping_address as string),
  totalAmount: Number(row.total_amount),
  currency: row.currency as Order['currency'],
  customerEmail: row.customer_email as string | undefined,
  customerNote: row.customer_note as string | undefined,
  status: row.status as OrderStatus,
  createdAt: row.created_at as string,
  updatedAt: row.updated_at as string,
});

const VALID_STATUS_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  [OrderStatus.PENDING]: [OrderStatus.CONFIRMED, OrderStatus.CANCELLED],
  [OrderStatus.CONFIRMED]: [OrderStatus.PROCESSING, OrderStatus.CANCELLED],
  [OrderStatus.PROCESSING]: [OrderStatus.SHIPPED, OrderStatus.CANCELLED],
  [OrderStatus.SHIPPED]: [OrderStatus.DELIVERED, OrderStatus.REFUNDED],
  [OrderStatus.DELIVERED]: [OrderStatus.REFUNDED],
  [OrderStatus.CANCELLED]: [],
  [OrderStatus.REFUNDED]: [],
};

// ---- Schema init ----

export async function initOrdersTable(): Promise<void> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS orders (
      id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      platform_order_id VARCHAR(255) NOT NULL,
      platform      VARCHAR(50) NOT NULL,
      items         JSONB NOT NULL,
      shipping_address JSONB NOT NULL,
      total_amount  DECIMAL(12,2) NOT NULL,
      currency      VARCHAR(3) NOT NULL,
      customer_email VARCHAR(255),
      customer_note TEXT,
      status        VARCHAR(20) NOT NULL DEFAULT 'pending',
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(platform, platform_order_id)
    );
    CREATE INDEX IF NOT EXISTS idx_orders_platform ON orders(platform);
    CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
    CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders(created_at);
  `);
}

// ---- CRUD ----

export async function createOrder(dto: CreateOrderDTO): Promise<Order> {
  // Validate items
  if (!dto.items || dto.items.length === 0) {
    throw new AppError(400, 'Order must contain at least one item');
  }

  for (const item of dto.items) {
    if (item.quantity <= 0) {
      throw new AppError(400, `Invalid quantity for SKU ${item.sku}: must be positive`);
    }
    if (item.unitPrice < 0) {
      throw new AppError(400, `Invalid unit price for SKU ${item.sku}: cannot be negative`);
    }
  }

  if (dto.totalAmount < 0) {
    throw new AppError(400, 'Total amount cannot be negative');
  }

  const result = await db.query(
    `INSERT INTO orders (platform_order_id, platform, items, shipping_address, total_amount, currency, customer_email, customer_note)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [
      dto.platformOrderId,
      dto.platform,
      JSON.stringify(dto.items),
      JSON.stringify(dto.shippingAddress),
      dto.totalAmount,
      dto.currency,
      dto.customerEmail ?? null,
      dto.customerNote ?? null,
    ]
  );

  return mapRowToOrder(result.rows[0]);
}

export async function getOrderById(id: string): Promise<Order> {
  const result = await db.query('SELECT * FROM orders WHERE id = $1', [id]);
  if (result.rows.length === 0) {
    throw new AppError(404, `Order not found: ${id}`);
  }
  return mapRowToOrder(result.rows[0]);
}

export async function listOrders(query: OrderListQuery): Promise<PaginatedResult<Order>> {
  const conditions: string[] = [];
  const params: unknown[] = [];
  let paramIndex = 1;

  if (query.platform) {
    conditions.push(`platform = $${paramIndex++}`);
    params.push(query.platform);
  }
  if (query.status) {
    conditions.push(`status = $${paramIndex++}`);
    params.push(query.status);
  }
  if (query.startDate) {
    conditions.push(`created_at >= $${paramIndex++}`);
    params.push(query.startDate);
  }
  if (query.endDate) {
    conditions.push(`created_at <= $${paramIndex++}`);
    params.push(query.endDate);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const page = Math.max(1, query.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, query.pageSize ?? 20));
  const offset = (page - 1) * pageSize;

  const [countResult, dataResult] = await Promise.all([
    db.query(`SELECT COUNT(*) FROM orders ${whereClause}`, params),
    db.query(`SELECT * FROM orders ${whereClause} ORDER BY created_at DESC LIMIT $${paramIndex++} OFFSET $${paramIndex++}`, [
      ...params,
      pageSize,
      offset,
    ]),
  ]);

  return {
    data: dataResult.rows.map(mapRowToOrder),
    total: Number(countResult.rows[0].count),
    page,
    pageSize,
  };
}

export async function updateOrderStatus(id: string, dto: UpdateOrderStatusDTO): Promise<Order> {
  const order = await getOrderById(id);

  const allowed = VALID_STATUS_TRANSITIONS[order.status];
  if (!allowed.includes(dto.status)) {
    throw new AppError(
      409,
      `Cannot transition order from "${order.status}" to "${dto.status}". Allowed: ${allowed.join(', ') || 'none'}`
    );
  }

  const updates: string[] = ["status = $2", "updated_at = NOW()"];
  const params: unknown[] = [id, dto.status];
  let paramIndex = 3;

  if (dto.trackingNumber) {
    updates.push(`tracking_number = $${paramIndex++}`);
    params.push(dto.trackingNumber);
  }
  if (dto.reason) {
    updates.push(`cancellation_reason = $${paramIndex++}`);
    params.push(dto.reason);
  }

  const result = await db.query(
    `UPDATE orders SET ${updates.join(', ')} WHERE id = $1 RETURNING *`,
    params
  );

  return mapRowToOrder(result.rows[0]);
}
