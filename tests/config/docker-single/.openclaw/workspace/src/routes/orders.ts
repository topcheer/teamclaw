import { Router } from 'express';
import { validateBody, validateQuery } from '../middleware/errors';
import { createOrderSchema, updateOrderStatusSchema, orderListQuerySchema } from '../types/validators';
import * as orderService from '../services/orderService';

const router = Router();

/** POST /api/orders — 创建订单 */
router.post('/', validateBody(createOrderSchema), async (req, res, next) => {
  try {
    const order = await orderService.createOrder(req.body);
    res.status(201).json({ success: true, data: order });
  } catch (err) {
    next(err);
  }
});

/** GET /api/orders — 订单列表（支持平台、状态、时间范围筛选） */
router.get('/', validateQuery(orderListQuerySchema), async (req, res, next) => {
  try {
    const result = await orderService.listOrders(req.query);
    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
});

/** GET /api/orders/:id — 获取订单详情 */
router.get('/:id', async (req, res, next) => {
  try {
    const order = await orderService.getOrderById(req.params.id);
    res.json({ success: true, data: order });
  } catch (err) {
    next(err);
  }
});

/** PUT /api/orders/:id/status — 更新订单状态 */
router.put('/:id/status', validateBody(updateOrderStatusSchema), async (req, res, next) => {
  try {
    const order = await orderService.updateOrderStatus(
      req.params.id,
      req.body.status
    );
    res.json({ success: true, data: order });
  } catch (err) {
    next(err);
  }
});

export default router;
