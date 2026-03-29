import { v4 as uuidv4 } from 'uuid';
import type {
  Order,
  CreateOrderRequest,
  OrderListQuery,
  OrderStatus,
} from '../types';
import { pool } from './db';
import { ApiError } from '../middleware/errors';

/** 计算订单总金额 */
function computeTotal(
  lineItems: CreateOrderRequest['lineItems']
): { amount: number; currency: string } {
  // 所有商品必须使用相同货币（业务规则）
  const currencies = new Set(lineItems.map((i) => i.currency));
  if (currencies.size > 1) {
    throw new ApiError(400, 'All line items must use the same currency');
  }
  const currency = lineItems[0].currency;
  const amount = lineItems.reduce(
    (sum, item) => sum + item.quantity * item.unitPrice,
    0
  );
  // JPY 无小数位，其他保留 2 位
  const rounded =
    currency === 'JPY' ? Math.round(amount) : Math.round(amount * 100) / 100;
  return { amount: rounded, currency };
}

/** 创建订单 */
export async function createOrder(data: CreateOrderRequest): Promise<Order> {
  const { amount, currency } = computeTotal(data.lineItems);
  const id = uuidv4();
  const now = new Date().toISOString();

  const order: Order = {
    id,
    platformInfo: data.platformInfo,
    lineItems: data.lineItems,
    shippingAddress: data.shippingAddress,
    customerEmail: data.customerEmail,
    customerNote: data.customerNote,
    status: 'pending',
    totalAmount: amount,
    currency: currency as any,
    createdAt: now,
    updatedAt: now,
  };

  await pool.query(
    `INSERT INTO orders (id, platform, platform_order_id, store_id, status,
       total_amount, currency, line_items, shipping_address,
       customer_email, customer_note, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [
      id,
      data.platformInfo.platform,
      data.platformInfo.platformOrderId,
      data.platformInfo.storeId,
      'pending',
      amount,
      currency,
      JSON.stringify(data.lineItems),
      JSON.stringify(data.shippingAddress),
      data.customerEmail ?? null,
      data.customerNote ?? null,
      now,
      now,
    ]
  );

  return order;
}

/** 获取订单详情 */
export async function getOrderById(id: string): Promise<Order> {
  const { rows } = await pool.query(
    `SELECT * FROM orders WHERE id = $1`,
    [id]
  );
  if (rows.length === 0) {
    throw new ApiError(404, `Order ${id} not found`);
  }
  return mapRowToOrder(rows[0]);
}

/** 查询订单列表 */
export async function listOrders(query: OrderListQuery): Promise<{
  orders: Order[];
  total: number;
  page: number;
  pageSize: number;
}> {
  const conditions: string[] = [];
  const params: unknown[] = [];
  let idx = 1;

  if (query.platform) {
    conditions.push(`platform = $${idx++}`);
    params.push(query.platform);
  }
  if (query.status) {
    conditions.push(`status = $${idx++}`);
    params.push(query.status);
  }
  if (query.startDate) {
    conditions.push(`created_at >= $${idx++}`);
    params.push(query.startDate);
  }
  if (query.endDate) {
    conditions.push(`created_at <= $${idx++}`);
    params.push(query.endDate);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const page = query.page ?? 1;
  const pageSize = query.pageSize ?? 20;
  const offset = (page - 1) * pageSize;

  const countRes = await pool.query(`SELECT COUNT(*) FROM orders ${where}`, params);
  const total = parseInt(countRes.rows[0].count, 10);

  const dataRes = await pool.query(
    `SELECT * FROM orders ${where} ORDER BY created_at DESC LIMIT $${idx} OFFSET $${idx + 1}`,
    [...params, pageSize, offset]
  );

  return {
    orders: dataRes.rows.map(mapRowToOrder),
    total,
    page,
    pageSize,
  };
}

/** 更新订单状态（状态机校验） */
const ALLOWED_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  pending: ['confirmed', 'cancelled'],
  confirmed: ['processing', 'cancelled'],
  processing: ['shipped', 'cancelled'],
  shipped: ['delivered'],
  delivered: ['refunded'],
  cancelled: [],
  refunded: [],
};

export async function updateOrderStatus(
  id: string,
  newStatus: OrderStatus
): Promise<Order> {
  const order = await getOrderById(id);

  if (!ALLOWED_TRANSITIONS[order.status].includes(newStatus)) {
    throw new ApiError(
      409,
      `Cannot transition from ${order.status} to ${newStatus}`
    );
  }

  const now = new Date().toISOString();
  await pool.query(
    `UPDATE orders SET status = $1, updated_at = $2 WHERE id = $3`,
    [newStatus, now, id]
  );

  return { ...order, status: newStatus, updatedAt: now };
}

/** 数据库行映射为 Order 对象 */
function mapRowToOrder(row: any): Order {
  return {
    id: row.id,
    platformInfo: {
      platform: row.platform,
      platformOrderId: row.platform_order_id,
      storeId: row.store_id,
    },
    lineItems: typeof row.line_items === 'string' ? JSON.parse(row.line_items) : row.line_items,
    shippingAddress: typeof row.shipping_address === 'string' ? JSON.parse(row.shipping_address) : row.shipping_address,
    customerEmail: row.customer_email ?? undefined,
    customerNote: row.customer_note ?? undefined,
    status: row.status,
    totalAmount: parseFloat(row.total_amount),
    currency: row.currency,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
