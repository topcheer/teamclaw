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

/** 支持的货币 */
export type Currency = 'USD' | 'CNY' | 'EUR' | 'JPY';

/** 商品明细行 */
export interface OrderLineItem {
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
  country: string;
  state?: string;
  city: string;
  addressLine1: string;
  addressLine2?: string;
  postalCode: string;
}

/** 订单来源平台信息 */
export interface PlatformInfo {
  platform: Platform;
  platformOrderId: string;
  storeId: string;
}

/** 创建订单请求体 */
export interface CreateOrderRequest {
  platformInfo: PlatformInfo;
  lineItems: OrderLineItem[];
  shippingAddress: ShippingAddress;
  customerEmail?: string;
  customerNote?: string;
}

/** 订单（完整） */
export interface Order {
  id: string;
  platformInfo: PlatformInfo;
  lineItems: OrderLineItem[];
  shippingAddress: ShippingAddress;
  customerEmail?: string;
  customerNote?: string;
  status: OrderStatus;
  totalAmount: number;
  currency: Currency;
  createdAt: string;
  updatedAt: string;
}

/** 订单列表查询参数 */
export interface OrderListQuery {
  platform?: Platform;
  status?: OrderStatus;
  startDate?: string;
  endDate?: string;
  page?: number;
  pageSize?: number;
}

/** 库存记录 */
export interface InventoryItem {
  sku: string;
  productName: string;
  quantity: number;
  reservedQuantity: number;
  availableQuantity: number;
  platformQuantities: Partial<Record<Platform, number>>;
  lastSyncAt: string;
  updatedAt: string;
}

/** 更新库存请求体 */
export interface UpdateInventoryRequest {
  quantity?: number;
  reservedQuantity?: number;
}

/** 库存同步结果 */
export interface SyncResult {
  syncedSkus: number;
  conflicts: Array<{ sku: string; message: string }>;
  syncedAt: string;
}
