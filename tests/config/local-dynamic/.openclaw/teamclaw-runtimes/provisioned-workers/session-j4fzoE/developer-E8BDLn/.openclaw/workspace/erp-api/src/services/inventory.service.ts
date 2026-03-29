// src/services/inventory.service.ts
import pool from '../config/database';
import { acquireLock, releaseLock } from '../config/redis';
import {
  InventoryRecord,
  Platform,
  UpdateInventoryDto,
} from '../types';

/** 获取 SKU 在各平台的库存 */
export async function getInventoryBySku(
  sku: string
): Promise<InventoryRecord[]> {
  const result = await pool.query(
    'SELECT * FROM inventory WHERE sku = $1',
    [sku]
  );
  return result.rows.map(mapRowToInventory);
}

/** 更新 SKU 在指定平台的库存（带分布式锁） */
export async function updateInventory(
  sku: string,
  platform: Platform,
  dto: UpdateInventoryDto
): Promise<InventoryRecord> {
  if (dto.available < 0) {
    throw new Error('Available quantity cannot be negative');
  }
  if (dto.reserved !== undefined && dto.reserved < 0) {
    throw new Error('Reserved quantity cannot be negative');
  }

  const lockKey = `inventory:lock:${sku}:${platform}`;
  const acquired = await acquireLock(lockKey, 10000);
  if (!acquired) {
    throw new Error(
      'Inventory lock is held by another operation, please retry'
    );
  }

  try {
    const result = await pool.query(
      `INSERT INTO inventory (sku, platform, available, reserved, last_synced_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (sku, platform) DO UPDATE SET
         available = $3,
         reserved = COALESCE($4, inventory.reserved),
         last_synced_at = NOW()
       RETURNING *`,
      [sku, platform, dto.available, dto.reserved ?? 0]
    );

    return mapRowToInventory(result.rows[0]);
  } finally {
    await releaseLock(lockKey);
  }
}

/** 多平台库存同步（带分布式锁防止并发冲突） */
export async function syncInventory(): Promise<{
  synced: InventoryRecord[];
  errors: Array<{ platform: Platform; error: string }>;
}> {
  const lockKey = 'inventory:sync:lock';
  const acquired = await acquireLock(lockKey, 30000);
  if (!acquired) {
    throw new Error('Inventory sync already in progress');
  }

  const platforms: Platform[] = ['amazon', 'shopify', 'tiktok_shop'];
  const synced: InventoryRecord[] = [];
  const errors: Array<{ platform: Platform; error: string }> = [];

  try {
    for (const platform of platforms) {
      try {
        // 从外部平台 API 拉取最新库存
        const platformInventory = await fetchPlatformInventory(platform);

        for (const item of platformInventory) {
          const result = await pool.query(
            `INSERT INTO inventory (sku, platform, available, reserved, warehouse_code, last_synced_at)
             VALUES ($1, $2, $3, $4, $5, NOW())
             ON CONFLICT (sku, platform) DO UPDATE SET
               available = $3,
               reserved = $4,
               warehouse_code = $5,
               last_synced_at = NOW()
             RETURNING *`,
            [item.sku, platform, item.available, item.reserved, item.warehouseCode]
          );
          synced.push(mapRowToInventory(result.rows[0]));
        }
      } catch (err) {
        errors.push({
          platform,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  } finally {
    await releaseLock(lockKey);
  }

  return { synced, errors };
}

/**
 * 模拟从各平台 API 拉取库存数据
 * 生产环境中应替换为实际的平台 SDK 调用
 */
async function fetchPlatformInventory(
  platform: Platform
): Promise<
  Array<{
    sku: string;
    available: number;
    reserved: number;
    warehouseCode: string;
  }>
> {
  // 生产环境替换为真实的平台 API 调用
  // Amazon: Selling Partner API / Finances API
  // Shopify: InventoryLevel REST API
  // TikTok Shop: /product/stock/list
  const result = await pool.query(
    `SELECT sku, available, reserved, warehouse_code
     FROM inventory
     WHERE platform = $1`,
    [platform]
  );
  return result.rows.map((row) => ({
    sku: row.sku,
    available: parseInt(row.available, 10),
    reserved: parseInt(row.reserved, 10),
    warehouseCode: row.warehouse_code,
  }));
}

function mapRowToInventory(row: Record<string, unknown>): InventoryRecord {
  return {
    sku: row.sku as string,
    platform: row.platform as Platform,
    available: parseInt(row.available as string, 10),
    reserved: parseInt(row.reserved as string, 10),
    warehouseCode: row.warehouse_code as string,
    lastSyncedAt: row.last_synced_at as string,
  };
}
