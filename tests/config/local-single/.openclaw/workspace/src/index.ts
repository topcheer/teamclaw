import express from 'express';
import cors from 'cors';
import ordersRouter from './routes/orders';
import inventoryRouter from './routes/inventory';
import { errorHandler } from './middleware/errorHandler';
import { initOrdersTable } from './services/orderService';
import { initInventoryTable } from './services/inventoryService';

const app = express();
const PORT = Number(process.env.PORT) || 3000;

// ---- Middleware ----
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// ---- Routes ----
app.use('/api/orders', ordersRouter);
app.use('/api/inventory', inventoryRouter);

// ---- Health check ----
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ---- Error handler ----
app.use(errorHandler);

// ---- Start ----
async function start() {
  try {
    console.log('[ERP] Initializing database tables...');
    await initOrdersTable();
    await initInventoryTable();
    console.log('[ERP] Database ready.');

    app.listen(PORT, '0.0.0.0', () => {
      console.log(`[ERP] Server running on http://0.0.0.0:${PORT}`);
    });
  } catch (err) {
    console.error('[ERP] Failed to start:', err);
    process.exit(1);
  }
}

start();

export default app;
