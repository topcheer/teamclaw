import { db } from '../config/database';
import { nowISO } from '../config/utils';
import {
  InventoryItem,
  UpdateInventoryDTO,
  SyncResult,
  AppError,
  Platform,
  PlatformAdapter,
} from '../types';

// ---- In-memory platform adapters (would be external API clients in production) ----

class AmazonAdapter implements PlatformAdapter {
  platform = Platform.AMAZON;
  private store = new Map<string, number>();

  async fetchInventory(sku: string): Promise<number> {
    // Simulated — real impl calls Amazon SP-API
    return this.store.get(sku) ?? 0;
  }

  async updateInventory(sku: string, quantity: number): Promise<boolean> {
    this.store.set(sku, quantity);
    return true;
  }
}

class ShopifyAdapter implements PlatformAdapter {
  platform = Platform.SHOPIFY;
  private store = new Map<string, number>();

  async fetchInventory(sku: string): Promise<number> {
    return this.store.get(sku) ?? 0;
  }

  async updateInventory(sku: string, quantity: number): Promise<boolean> {
    this.store.set(sku, quantity);
    return true;
  }
}

class TikTokShopAdapter implements PlatformAdapter {
  platform = Platform.TIKTOK_SHOP;
  private store = new Map<string, number>();

  async fetchInventory(sku: string): Promise<number> {
    return this.store.get(sku) ?? 0;
  }

  async updateInventory(sku: string, quantity: number): Promise<boolean> {
    this.store.set(sku, quantity);
    return true;
  }
}

const adapters: PlatformAdapter[] = [
  new AmazonAdapter(),
  new ShopifyAdapter(),
  new TikTokShopAdapter(),
];

export function getAdapter(platform: Platform): PlatformAdapter {
  const adapter = adapters.find((a) => a.platform === platform);
  if (!adapter) throw new AppError(400, `Unsupported platform: ${platform}`);
  return adapter;
}

// ---- Schema init ----

export async function initInventoryTable(): Promise<void> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS inventory (
      sku              VARCHAR(255) PRIMARY KEY,
      product_name     VARCHAR(255) NOT NULL,
      quantity         INT NOT NULL DEFAULT 0 CHECK (quantity >= 0),
      reserved_quantity INT NOT NULL DEFAULT 0 CHECK (reserved_quantity >= 0),
      last_synced_at   TIMESTAMPTZ,
      updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS inventory_platform (
      sku      VARCHAR(255) NOT NULL REFERENCES inventory(sku) ON DELETE CASCADE,
      platform VARCHAR(50) NOT NULL,
      quantity INT NOT NULL DEFAULT 0 CHECK (quantity >= 0),
      PRIMARY KEY (sku, platform)
    );

    CREATE INDEX IF NOT EXISTS idx_inventory_sku ON inventory(sku);
  `);
}

// ---- Distributed lock via advisory lock ----

export async function withInventoryLock<T>(
  sku: string,
  fn: () => Promise<T>
): Promise<T> {
  const client = await db.getClient();
  try {
    // pg_advisory_lock uses int8 — hash sku to get a lock id
    const lockId = hashStringToInt(sku);
    await client.query('SELECT pg_advisory_lock($1)', [lockId]);
    const result = await fn();
    return result;
  } finally {
    const lockId = hashStringToInt(sku);
    await client.query('SELECT pg_advisory_unlock($1)', [lockId]);
    client.release();
  }
}

function hashStringToInt(s: string): number {
  let hash = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    hash = ((hash << 5) - hash + c) | 0;
  }
  return Math.abs(hash);
}

// ---- CRUD ----

export async function getInventoryBySku(sku: string): Promise<InventoryItem> {
  const result = await db.query('SELECT * FROM inventory WHERE sku = $1', [sku]);
  if (result.rows.length === 0) {
    throw new AppError(404, `Inventory not found for SKU: ${sku}`);
  }

  const row = result.rows[0];
  const platformResult = await db.query(
    'SELECT platform, quantity FROM inventory_platform WHERE sku = $1',
    [sku]
  );

  return {
    sku: row.sku,
    productName: row.product_name,
    quantity: Number(row.quantity),
    reservedQuantity: Number(row.reserved_quantity),
    availableQuantity: Number(row.quantity) - Number(row.reserved_quantity),
    platforms: platformResult.rows.map((r) => ({
      platform: r.platform as Platform,
      quantity: Number(r.quantity),
    })),
    lastSyncedAt: row.last_synced_at,
    updatedAt: row.updated_at,
  };
}

export async function updateInventory(
  sku: string,
  dto: UpdateInventoryDTO
): Promise<InventoryItem> {
  if (dto.quantity < 0) {
    throw new AppError(400, 'Inventory quantity cannot be negative');
  }

  return withInventoryLock(sku, async () => {
    const current = await db.query('SELECT quantity FROM inventory WHERE sku = $1 FOR UPDATE', [sku]);
    if (current.rows.length === 0) {
      throw new AppError(404, `Inventory not found for SKU: ${sku}`);
    }

    await db.query(
      'UPDATE inventory SET quantity = $2, updated_at = NOW() WHERE sku = $1',
      [sku, dto.quantity]
    );

    return getInventoryBySku(sku);
  });
}

export async function syncInventory(sku?: string): Promise<SyncResult[]> {
  const results: SyncResult[] = [];

  // Determine which SKUs to sync
  let skus: string[];
  if (sku) {
    const check = await db.query('SELECT sku FROM inventory WHERE sku = $1', [sku]);
    if (check.rows.length === 0) {
      throw new AppError(404, `Inventory not found for SKU: ${sku}`);
    }
    skus = [sku];
  } else {
    const allSkus = await db.query('SELECT sku FROM inventory');
    skus = allSkus.rows.map((r) => r.sku);
  }

  for (const targetSku of skus) {
    for (const adapter of adapters) {
      try {
        const remoteQty = await adapter.fetchInventory(targetSku);
        const current = await db.query(
          'SELECT quantity FROM inventory_platform WHERE sku = $1 AND platform = $2',
          [targetSku, adapter.platform]
        );

        const prevQty = current.rows.length > 0 ? Number(current.rows[0].quantity) : 0;

        await db.query(
          `INSERT INTO inventory_platform (sku, platform, quantity)
           VALUES ($1, $2, $3)
           ON CONFLICT (sku, platform) DO UPDATE SET quantity = $3`,
          [targetSku, adapter.platform, remoteQty]
        );

        // Also update total inventory to max across platforms
        const allPlatforms = await db.query(
          'SELECT MAX(quantity) as max_qty FROM inventory_platform WHERE sku = $1',
          [targetSku]
        );
        const maxQty = Number(allPlatforms.rows[0].max_qty);
        await db.query(
          'UPDATE inventory SET quantity = $2, last_synced_at = NOW(), updated_at = NOW() WHERE sku = $1',
          [targetSku, maxQty]
        );

        results.push({
          sku: targetSku,
          platform: adapter.platform,
          previousQuantity: prevQty,
          newQuantity: remoteQty,
          success: true,
        });
      } catch (err) {
        results.push({
          sku: targetSku,
          platform: adapter.platform,
          previousQuantity: 0,
          newQuantity: 0,
          success: false,
          error: err instanceof Error ? err.message : 'Unknown error',
        });
      }
    }
  }

  return results;
}
