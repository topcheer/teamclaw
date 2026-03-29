import { Router } from 'express';
import { validateBody } from '../middleware/errors';
import { updateInventorySchema } from '../types/validators';
import * as inventoryService from '../services/inventoryService';

const router = Router();

/** GET /api/inventory/sync — 触发多平台库存同步 */
router.get('/sync', async (_req, res, next) => {
  try {
    const result = await inventoryService.syncInventory();
    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
});

/** GET /api/inventory/:sku — 查询 SKU 库存 */
router.get('/:sku', async (req, res, next) => {
  try {
    const item = await inventoryService.getInventoryBySku(req.params.sku);
    res.json({ success: true, data: item });
  } catch (err) {
    next(err);
  }
});

/** PUT /api/inventory/:sku — 更新库存数量 */
router.put('/:sku', validateBody(updateInventorySchema), async (req, res, next) => {
  try {
    const item = await inventoryService.updateInventory(req.params.sku, req.body);
    res.json({ success: true, data: item });
  } catch (err) {
    next(err);
  }
});

export default router;
