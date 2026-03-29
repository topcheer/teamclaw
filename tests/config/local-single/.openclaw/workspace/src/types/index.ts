// ==================== Enums ====================

export enum Platform {
  AMAZON = 'amazon',
  SHOPIFY = 'shopify',
  TIKTOK_SHOP = 'tiktok_shop',
}

export enum OrderStatus {
  PENDING = 'pending',
  CONFIRMED = 'confirmed',
  PROCESSING = 'processing',
  SHIPPED = 'shipped',
  DELIVERED = 'delivered',
  CANCELLED = 'cancelled',
  REFUNDED = 'refunded',
}

export enum Currency {
  USD = 'USD',
  CNY = 'CNY',
  EUR = 'EUR',
  JPY = 'JPY',
}

// ==================== Order ====================

export interface OrderItem {
  sku: string;
  productName: string;
  quantity: number;
  unitPrice: number;
  currency: Currency;
}

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

export interface CreateOrderDTO {
  platformOrderId: string;
  platform: Platform;
  items: OrderItem[];
  shippingAddress: ShippingAddress;
  totalAmount: number;
  currency: Currency;
  customerEmail?: string;
  customerNote?: string;
}

export interface UpdateOrderStatusDTO {
  status: OrderStatus;
  trackingNumber?: string;
  reason?: string;
}

export interface Order extends CreateOrderDTO {
  id: string;
  status: OrderStatus;
  createdAt: string;
  updatedAt: string;
}

export interface OrderListQuery {
  platform?: Platform;
  status?: OrderStatus;
  startDate?: string;
  endDate?: string;
  page?: number;
  pageSize?: number;
}

export interface PaginatedResult<T> {
  data: T[];
  total: number;
  page: number;
  pageSize: number;
}

// ==================== Inventory ====================

export interface InventoryItem {
  sku: string;
  productName: string;
  quantity: number;
  reservedQuantity: number;
  availableQuantity: number;
  platforms: { platform: Platform; quantity: number }[];
  lastSyncedAt: string | null;
  updatedAt: string;
}

export interface UpdateInventoryDTO {
  quantity: number;
  reason?: string;
}

export interface SyncResult {
  sku: string;
  platform: Platform;
  previousQuantity: number;
  newQuantity: number;
  success: boolean;
  error?: string;
}

export interface PlatformAdapter {
  platform: Platform;
  fetchInventory(sku: string): Promise<number>;
  updateInventory(sku: string, quantity: number): Promise<boolean>;
}

// ==================== Errors ====================

export class AppError extends Error {
  constructor(
    public statusCode: number,
    message: string,
    public details?: unknown
  ) {
    super(message);
    this.name = 'AppError';
  }
}
