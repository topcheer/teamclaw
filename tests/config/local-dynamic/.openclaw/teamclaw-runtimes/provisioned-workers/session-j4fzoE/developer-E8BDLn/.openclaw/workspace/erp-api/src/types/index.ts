// src/types/index.ts

/** 支持的电商平台 */
export type Platform = 'amazon' | 'shopify' | 'tiktok_shop';

/** 订单状态 */
export type OrderStatus =
  | 'pending'
  | 'confirmed'
  | 'processing'
  | 'shipped'
  | 'delivered'
  | 'cancelled'
  | 'refunded';

/** 支持的币种 */
export type Currency = 'USD' | 'CNY' | 'EUR' | 'JPY';

/** 商品明细 */
export interface OrderItem {
  sku: string;
  productName: string;
  quantity: number;
  unitPrice: number;
  currency: Currency;
}

/** 收货地址 */
export interface ShippingAddress {
  recipientName: string;
  phone: string;
  line1: string;
  line2?: string;
  city: string;
  state?: string;
  postalCode: string;
  countryCode: string;
}

/** 创建订单请求体 */
export interface CreateOrderDto {
  platformOrderId: string;
  platform: Platform;
  items: OrderItem[];
  shippingAddress: ShippingAddress;
  customerEmail?: string;
  currency: Currency;
}

/** 订单查询筛选参数 */
export interface OrderQueryParams {
  platform?: Platform;
  status?: OrderStatus;
  startDate?: string;
  endDate?: string;
  page?: number;
  pageSize?: number;
}

/** 订单实体 */
export interface Order {
  id: string;
  platformOrderId: string;
  platform: Platform;
  status: OrderStatus;
  items: OrderItem[];
  shippingAddress: ShippingAddress;
  customerEmail?: string;
  currency: Currency;
  totalAmount: number;
  platformFee: number;
  createdAt: string;
  updatedAt: string;
}

/** 库存记录 */
export interface InventoryRecord {
  sku: string;
  platform: Platform;
  available: number;
  reserved: number;
  warehouseCode: string;
  lastSyncedAt: string;
}

/** 库存更新请求体 */
export interface UpdateInventoryDto {
  available: number;
  reserved?: number;
}

/** API 通用响应 */
export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
}

/** 分页响应 */
export interface PaginatedResponse<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}
