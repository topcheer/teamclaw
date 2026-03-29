import { Router, Request, Response, NextFunction } from 'express';
import { asyncHandler } from '../middleware/errorHandler';
import { validateBody } from '../middleware/errorHandler';
import {
  createOrder,
  getOrderById,
  listOrders,
  updateOrderStatus,
} from '../services/orderService';
import { CreateOrderDTO, UpdateOrderStatusDTO, OrderStatus, Platform } from '../types';

const router = Router();

// POST /api/orders — Create order
router.post(
  '/',
  validateBody(['platformOrderId', 'platform', 'items', 'shippingAddress', 'totalAmount', 'currency']),
  asyncHandler(async (req: Request, res: Response) => {
    const dto: CreateOrderDTO = {
      platformOrderId: req.body.platformOrderId,
      platform: req.body.platform as Platform,
      items: req.body.items,
      shippingAddress: req.body.shippingAddress,
      totalAmount: Number(req.body.totalAmount),
      currency: req.body.currency,
      customerEmail: req.body.customerEmail,
      customerNote: req.body.customerNote,
    };
    const order = await createOrder(dto);
    res.status(201).json({ data: order });
  })
);

// GET /api/orders/:id — Get order by ID
router.get(
  '/:id',
  asyncHandler(async (req: Request, res: Response) => {
    const order = await getOrderById(req.params.id);
    res.json({ data: order });
  })
);

// GET /api/orders — List orders with filters
router.get(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    const query = {
      platform: req.query.platform as Platform | undefined,
      status: req.query.status as OrderStatus | undefined,
      startDate: req.query.startDate as string | undefined,
      endDate: req.query.endDate as string | undefined,
      page: req.query.page ? Number(req.query.page) : undefined,
      pageSize: req.query.pageSize ? Number(req.query.pageSize) : undefined,
    };
    const result = await listOrders(query);
    res.json(result);
  })
);

// PUT /api/orders/:id/status — Update order status
router.put(
  '/:id/status',
  validateBody(['status']),
  asyncHandler(async (req: Request, res: Response) => {
    const dto: UpdateOrderStatusDTO = {
      status: req.body.status as OrderStatus,
      trackingNumber: req.body.trackingNumber,
      reason: req.body.reason,
    };
    const order = await updateOrderStatus(req.params.id, dto);
    res.json({ data: order });
  })
);

export default router;
