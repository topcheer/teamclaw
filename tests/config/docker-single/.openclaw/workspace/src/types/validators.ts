import { z } from 'zod';

export const currencyEnum = z.enum(['USD', 'CNY', 'EUR', 'JPY']);
export const platformEnum = z.enum(['amazon', 'shopify', 'tiktok_shop']);
export const orderStatusEnum = z.enum([
  'pending', 'confirmed', 'processing', 'shipped',
  'delivered', 'cancelled', 'refunded',
]);

const orderLineItemSchema = z.object({
  sku: z.string().min(1, 'SKU is required'),
  productName: z.string().min(1, 'Product name is required'),
  quantity: z.number().int().positive('Quantity must be positive'),
  unitPrice: z.number().nonnegative('Unit price cannot be negative'),
  currency: currencyEnum,
});

const shippingAddressSchema = z.object({
  recipientName: z.string().min(1, 'Recipient name is required'),
  phone: z.string().min(1, 'Phone is required'),
  country: z.string().min(1, 'Country is required'),
  state: z.string().optional(),
  city: z.string().min(1, 'City is required'),
  addressLine1: z.string().min(1, 'Address line 1 is required'),
  addressLine2: z.string().optional(),
  postalCode: z.string().min(1, 'Postal code is required'),
});

const platformInfoSchema = z.object({
  platform: platformEnum,
  platformOrderId: z.string().min(1, 'Platform order ID is required'),
  storeId: z.string().min(1, 'Store ID is required'),
});

export const createOrderSchema = z.object({
  platformInfo: platformInfoSchema,
  lineItems: z.array(orderLineItemSchema).min(1, 'At least one line item is required'),
  shippingAddress: shippingAddressSchema,
  customerEmail: z.string().email().optional(),
  customerNote: z.string().max(500).optional(),
});

export const updateOrderStatusSchema = z.object({
  status: orderStatusEnum,
});

export const updateInventorySchema = z.object({
  quantity: z.number().int().min(0, 'Quantity cannot be negative').optional(),
  reservedQuantity: z.number().int().min(0, 'Reserved quantity cannot be negative').optional(),
});

export const orderListQuerySchema = z.object({
  platform: platformEnum.optional(),
  status: orderStatusEnum.optional(),
  startDate: z.string().datetime().optional(),
  endDate: z.string().datetime().optional(),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});
