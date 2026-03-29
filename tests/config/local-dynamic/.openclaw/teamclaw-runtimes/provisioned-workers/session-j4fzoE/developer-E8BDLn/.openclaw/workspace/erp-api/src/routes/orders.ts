// src/routes/orders.ts
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import * as orderService from '../services/order.service';
import { validateBody, validateQuery } from '../middleware/validate';
import { Platform, OrderStatus, Currency } from '../types';

const router = Router();

const orderItemSchema = z.object({
  sku: z.string().min(1),
  productName: z.string().min(1),
  quantity: z.number().int().positive(),
  unitPrice: z.number().nonnegative(),
  currency: z.enum(['USD', 'CNY', 'EUR', 'JPY']),
});

const shippingAddressSchema = z.object({
  recipientName: z.string().min(1),
  phone: z.string().min(1),
  line1: z.string().min(1),
  line2: z.string().optional(),
  city: z.string().min(1),
  state: z.string().optional(),
  postalCode: z.string().min(1),
  countryCode: z.string().length(2),
});

const createOrderSchema = z.object({
  platformOrderId: z.string().min(1),
  platform: z.enum(['amazon', 'shopify', 'tiktok_shop']),
  items: z.array(orderItemSchema).min(1),
  shippingAddress: shippingAddressSchema,
  customerEmail: z.string().email().optional(),
  currency: z.enum(['USD', 'CNY', 'EUR', 'JPY']),
});

const orderQuerySchema = z.object({
  platform: z.enum(['amazon', 'shopify', 'tiktok_shop']).optional(),
  status: z.enum(['pending', 'confirmed', 'processing', 'shipped', 'delivered', 'cancelled', 'refunded']).optional(),
  startDate: z.string().datetime().optional(),
  endDate: z.string().datetime().optional(),
  page: z.coerce.number().int().positive().optional(),
  pageSize: z.coerce.number().int().positive().max(100).optional(),
});

const updateStatusSchema = z.object({
  status: z.enum(['pending', 'confirmed', 'processing', 'shipped', 'delivered', 'cancelled', 'refunded']),
});

/** POST /api/orders — 创建订单 */
router.post(
  '/',
  validateBody(createOrderSchema),
  async (req: Request, res: Response) => {
    try {
      const order = await orderService.createOrder(req.body);
      res.status(201).json({ success: true, data: order });
    } catch (err) {
      if ((err as any).code === '23505') {
        res.status(409).json({
          success: false,
          error: 'Duplicate platform order ID',
        });
        return;
      }
      throw err;
    }
  }
);

/** GET /api/orders — 订单列表 */
router.get(
  '/',
  validateQuery(orderQuerySchema),
  async (req: Request, res: Response) => {
    const result = await orderService.listOrders(req.query as any);
    res.json({ success: true, data: result });
  }
);

/** GET /api/orders/:id — 订单详情 */
router.get('/:id', async (req: Request, res: Response) => {
  const order = await orderService.getOrderById(req.params.id);
  if (!order) {
    res.status(404).json({ success: false, error: 'Order not found' });
    return;
  }
  res.json({ success: true, data: order });
});

/** PUT /api/orders/:id/status — 更新订单状态 */
router.put(
  '/:id/status',
  validateBody(updateStatusSchema),
  async (req: Request, res: Response) => {
    try {
      const order = await orderService.updateOrderStatus(
        req.params.id,
        req.body.status
      );
      res.json({ success: true, data: order });
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.includes('not found')) {
        res.status(404).json({ success: false, error: msg });
        return;
      }
      if (msg.includes('Cannot transition')) {
        res.status(422).json({ success: false, error: msg });
        return;
      }
      throw err;
    }
  }
);

export default router;
