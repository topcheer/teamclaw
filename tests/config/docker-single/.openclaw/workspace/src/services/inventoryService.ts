import type { InventoryItem, UpdateInventoryRequest, Platform, SyncResult } from '../types';
import { pool, redis, acquireLock, releaseLock } from './db';
import { ApiError } from '../middleware/errors';

/** 查询 SKU 库存 */
export async function getInventoryBySku(sku: string): Promise<InventoryItem> {
  const { rows } = await pool.query(
    `SELECT * FROM inventory WHERE sku = $1`,
    [sku]
  );
  if (rows.length === 0) {
    throw new ApiError(404, `SKU ${sku} not found`);
  }
  return mapRowToInventory(rows[0]);
}

/** 更新库存数量（带分布式锁防超卖） */
export async function updateInventory(
  sku: string,
  data: UpdateInventoryRequest
): Promise<InventoryItem> {
  const lockId = await acquireLock(`inventory:${sku}`, 10);
  if (!lockId) {
    throw new ApiError(409, `Inventory for ${sku} is currently being updated`);
  }

  try {
    const current = await getInventoryBySku(sku);

    const newQuantity =
      data.quantity !== undefined ? data.quantity : current.quantity;
    const newReserved =
      data.reservedQuantity !== undefined
        ? data.reservedQuantity
        : current.reservedQuantity;

    if (newReserved > newQuantity) {
      throw new ApiError(
        400,
        `Reserved quantity (${newReserved}) cannot exceed total quantity (${newQuantity})`
      );
    }

    const available = newQuantity - newReserved;
    const now = new Date().toISOString();

    await pool.query(
      `UPDATE inventory SET quantity = $1, reserved_quantity = $2,
        available_quantity = $3, updated_at = $4 WHERE sku = $5`,
      [newQuantity, newReserved, available, now, sku]
    );

    // 更新缓存
    await redis.set(
      `inventory:${sku}`,
      JSON.stringify({ quantity: newQuantity, reservedQuantity: newReserved, availableQuantity: available }),
      'EX',
      300
    );

    const updated = await getInventoryBySku(sku);
    return updated;
  } finally {
    await releaseLock(`inventory:${sku}`, lockId);
  }
}

/** 多平台库存同步 */
export async function syncInventory(): Promise<SyncResult> {
  const lockId = await acquireLock('inventory:sync', 30);
  if (!lockId) {
    throw new ApiError(409, 'Inventory sync is already in progress');
  }

  try {
    const { rows } = await pool.query(`SELECT * FROM inventory`);

    const conflicts: SyncResult['conflicts'] = [];
    let syncedSkus = 0;

    for (const row of rows) {
      const item = mapRowToInventory(row);
      const platformQuantities: Partial<Record<Platform, number>> = {};

      // 模拟从各平台拉取库存 — 实际实现中会调用平台 API
      for (const platform of ['amazon', 'shopify', 'tiktok_shop'] as Platform[]) {
        try {
          const platformQty = await fetchPlatformInventory(platform, item.sku);
          platformQuantities[platform] = platformQty;
        } catch {
          conflicts.push({
            sku: item.sku,
            message: `Failed to fetch inventory from ${platform}`,
          });
        }
      }

      // 取所有平台的最小值作为可用库存（防止超卖）
      const quantities = Object.values(platformQuantities).filter((q): q is number => q !== undefined);
      if (quantities.length > 0) {
        const minQty = Math.min(...quantities);

        if (minQty < 0) {
          conflicts.push({
            sku: item.sku,
            message: `Platform returned negative quantity (${minQty}), skipping`,
          });
          continue;
        }

        await pool.query(
          `UPDATE inventory SET quantity = $1, available_quantity = $1 - reserved_quantity,
            platform_quantities = $2, last_sync_at = $3, updated_at = $3 WHERE sku = $4`,
          [minQty, JSON.stringify(platformQuantities), new Date().toISOString(), item.sku]
        );
        syncedSkus++;
      }
    }

    return {
      syncedSkus,
      conflicts,
      syncedAt: new Date().toISOString(),
    };
  } finally {
    await releaseLock('inventory:sync', lockId);
  }
}

/** 调用平台 API 获取库存（桩实现） */
async function fetchPlatformInventory(
  platform: Platform,
  sku: string
): Promise<number> {
  // 实际实现：调用 Amazon SP-API / Shopify REST API / TikTok Shop API
  console.log(`[Stub] Fetching inventory for ${sku} from ${platform}`);
  return 100; // stub
}

function mapRowToInventory(row: any): InventoryItem {
  return {
    sku: row.sku,
    productName: row.product_name,
    quantity: row.quantity,
    reservedQuantity: row.reserved_quantity,
    availableQuantity: row.available_quantity,
    platformQuantities:
      typeof row.platform_quantities === 'string'
        ? JSON.parse(row.platform_quantities)
        : row.platform_quantities ?? {},
    lastSyncAt: row.last_sync_at,
    updatedAt: row.updated_at,
  };
}
