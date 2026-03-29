// src/services/order.service.ts
import { v4 as uuidv4 } from 'uuid';
import pool from '../config/database';
import {
  CreateOrderDto,
  Order,
  OrderQueryParams,
  OrderStatus,
  PaginatedResponse,
  Platform,
} from '../types';

const VALID_STATUS_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  pending: ['confirmed', 'cancelled'],
  confirmed: ['processing', 'cancelled'],
  processing: ['shipped', 'cancelled'],
  shipped: ['delivered'],
  delivered: ['refunded'],
  cancelled: [],
  refunded: [],
};

function calculateTotal(items: CreateOrderDto['items']): number {
  return items.reduce(
    (sum, item) => sum + item.unitPrice * item.quantity,
    0
  );
}

function calculatePlatformFee(total: number, platform: Platform): number {
  const rates: Record<Platform, number> = {
    amazon: 0.15,
    shopify: 0.029 + 0.3,
    tiktok_shop: 0.05,
  };
  // Shopify 的最低手续费逻辑
  if (platform === 'shopify') {
    return Math.max(total * rates.shopify, 0.3);
  }
  return total * rates[platform];
}

export async function createOrder(dto: CreateOrderDto): Promise<Order> {
  const id = uuidv4();
  const totalAmount = calculateTotal(dto.items);
  const platformFee = calculatePlatformFee(totalAmount, dto.platform);

  const result = await pool.query(
    `INSERT INTO orders (
      id, platform_order_id, platform, status, items, shipping_address,
      customer_email, currency, total_amount, platform_fee
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    RETURNING *`,
    [
      id,
      dto.platformOrderId,
      dto.platform,
      'pending',
      JSON.stringify(dto.items),
      JSON.stringify(dto.shippingAddress),
      dto.customerEmail || null,
      dto.currency,
      totalAmount,
      platformFee,
    ]
  );

  return mapRowToOrder(result.rows[0]);
}

export async function getOrderById(id: string): Promise<Order | null> {
  const result = await pool.query('SELECT * FROM orders WHERE id = $1', [id]);
  return result.rows.length > 0 ? mapRowToOrder(result.rows[0]) : null;
}

export async function listOrders(
  params: OrderQueryParams
): Promise<PaginatedResponse<Order>> {
  const conditions: string[] = [];
  const values: unknown[] = [];
  let paramIndex = 1;

  if (params.platform) {
    conditions.push(`platform = $${paramIndex++}`);
    values.push(params.platform);
  }
  if (params.status) {
    conditions.push(`status = $${paramIndex++}`);
    values.push(params.status);
  }
  if (params.startDate) {
    conditions.push(`created_at >= $${paramIndex++}`);
    values.push(params.startDate);
  }
  if (params.endDate) {
    conditions.push(`created_at <= $${paramIndex++}`);
    values.push(params.endDate);
  }

  const whereClause =
    conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const page = Math.max(1, params.page || 1);
  const pageSize = Math.min(100, Math.max(1, params.pageSize || 20));
  const offset = (page - 1) * pageSize;

  const countResult = await pool.query(
    `SELECT COUNT(*) FROM orders ${whereClause}`,
    values
  );
  const total = parseInt(countResult.rows[0].count, 10);

  const dataResult = await pool.query(
    `SELECT * FROM orders ${whereClause} ORDER BY created_at DESC LIMIT $${paramIndex++} OFFSET $${paramIndex++}`,
    [...values, pageSize, offset]
  );

  return {
    items: dataResult.rows.map(mapRowToOrder),
    total,
    page,
    pageSize,
    totalPages: Math.ceil(total / pageSize),
  };
}

export async function updateOrderStatus(
  id: string,
  newStatus: OrderStatus
): Promise<Order> {
  const order = await getOrderById(id);
  if (!order) {
    throw new Error(`Order ${id} not found`);
  }

  const allowedTransitions = VALID_STATUS_TRANSITIONS[order.status];
  if (!allowedTransitions.includes(newStatus)) {
    throw new Error(
      `Cannot transition from ${order.status} to ${newStatus}. Allowed: ${allowedTransitions.join(', ')}`
    );
  }

  const result = await pool.query(
    `UPDATE orders SET status = $1, updated_at = NOW() WHERE id = $2 RETURNING *`,
    [newStatus, id]
  );

  return mapRowToOrder(result.rows[0]);
}

function mapRowToOrder(row: Record<string, unknown>): Order {
  return {
    id: row.id as string,
    platformOrderId: row.platform_order_id as string,
    platform: row.platform as Platform,
    status: row.status as OrderStatus,
    items: typeof row.items === 'string' ? JSON.parse(row.items) : (row.items as Order['items']),
    shippingAddress:
      typeof row.shipping_address === 'string'
        ? JSON.parse(row.shipping_address)
        : (row.shipping_address as Order['shippingAddress']),
    customerEmail: (row.customer_email as string) || undefined,
    currency: row.currency as Order['currency'],
    totalAmount: parseFloat(row.total_amount as string),
    platformFee: parseFloat(row.platform_fee as string),
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}
