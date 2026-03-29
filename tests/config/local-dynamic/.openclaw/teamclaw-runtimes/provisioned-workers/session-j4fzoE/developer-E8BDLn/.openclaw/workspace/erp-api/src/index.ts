// src/index.ts
import express from 'express';
import { connectRedis, disconnectRedis } from './config/redis';
import { errorHandler } from './middleware/errorHandler';
import orderRoutes from './routes/orders';
import inventoryRoutes from './routes/inventory';

const app = express();
const PORT = parseInt(process.env.PORT || '3000', 10);

app.use(express.json());

// API routes
app.use('/api/orders', orderRoutes);
app.use('/api/inventory', inventoryRoutes);

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Error handling
app.use(errorHandler);

async function start() {
  try {
    await connectRedis();
    console.log('Redis connected');
  } catch {
    console.warn('Redis connection failed — distributed locking will not work');
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`ERP API server running on port ${PORT}`);
  });
}

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM received, shutting down...');
  await disconnectRedis();
  process.exit(0);
});

start().catch(console.error);

export default app;
