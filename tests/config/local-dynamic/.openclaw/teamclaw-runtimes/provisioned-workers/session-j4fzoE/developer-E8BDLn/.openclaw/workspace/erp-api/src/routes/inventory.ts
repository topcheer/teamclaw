// src/routes/inventory.ts
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import * as inventoryService from '../services/inventory.service';
import { validateBody } from '../middleware/validate';

const router = Router();

const updateInventorySchema = z.object({
  available: z.number().int().min(0),
  reserved: z.number().int().min(0).optional(),
});

/** GET /api/inventory/sync — 触发多平台库存同步 */
router.get('/sync', async (_req: Request, res: Response) => {
  try {
    const result = await inventoryService.syncInventory();
    res.json({
      success: true,
      data: {
        syncedCount: result.synced.length,
        errors: result.errors,
      },
    });
  } catch (err) {
    const msg = (err as Error).message;
    if (msg.includes('already in progress')) {
      res.status(409).json({ success: false, error: msg });
      return;
    }
    throw err;
  }
});

/** GET /api/inventory/:sku — 查询 SKU 库存 */
router.get('/:sku', async (req: Request, res: Response) => {
  const records = await inventoryService.getInventoryBySku(req.params.sku);
  if (records.length === 0) {
    res.status(404).json({
      success: false,
      error: `No inventory found for SKU: ${req.params.sku}`,
    });
    return;
  }
  res.json({ success: true, data: records });
});

/** PUT /api/inventory/:sku — 更新库存数量 */
router.put(
  '/:sku',
  validateBody(updateInventorySchema),
  async (req: Request, res: Response) => {
    const { platform } = req.query as { platform?: string };
    if (!platform || !['amazon', 'shopify', 'tiktok_shop'].includes(platform)) {
      res.status(400).json({
        success: false,
        error: 'Query param "platform" is required (amazon|shopify|tiktok_shop)',
      });
      return;
    }
    try {
      const record = await inventoryService.updateInventory(
        req.params.sku,
        platform as any,
        req.body
      );
      res.json({ success: true, data: record });
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.includes('lock is held')) {
        res.status(429).json({ success: false, error: msg });
        return;
      }
      if (msg.includes('cannot be negative')) {
        res.status(422).json({ success: false, error: msg });
        return;
      }
      throw err;
    }
  }
);

export default router;
