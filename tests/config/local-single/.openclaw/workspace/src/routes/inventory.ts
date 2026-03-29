import { Router, Request, Response } from 'express';
import { asyncHandler } from '../middleware/errorHandler';
import { validateBody } from '../middleware/errorHandler';
import {
  getInventoryBySku,
  updateInventory,
  syncInventory,
} from '../services/inventoryService';
import { UpdateInventoryDTO } from '../types';

const router = Router();

// GET /api/inventory/sync — Trigger multi-platform inventory sync
router.get(
  '/sync',
  asyncHandler(async (req: Request, res: Response) => {
    const sku = req.query.sku as string | undefined;
    const results = await syncInventory(sku);
    res.json({
      data: results,
      summary: {
        total: results.length,
        succeeded: results.filter((r) => r.success).length,
        failed: results.filter((r) => !r.success).length,
      },
    });
  })
);

// GET /api/inventory/:sku — Get SKU inventory
router.get(
  '/:sku',
  asyncHandler(async (req: Request, res: Response) => {
    const item = await getInventoryBySku(req.params.sku);
    res.json({ data: item });
  })
);

// PUT /api/inventory/:sku — Update inventory quantity
router.put(
  '/:sku',
  validateBody(['quantity']),
  asyncHandler(async (req: Request, res: Response) => {
    const dto: UpdateInventoryDTO = {
      quantity: Number(req.body.quantity),
      reason: req.body.reason,
    };
    const item = await updateInventory(req.params.sku, dto);
    res.json({ data: item });
  })
);

export default router;
