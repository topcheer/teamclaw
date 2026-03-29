import express from 'express';
import { errorHandler } from './middleware/errors';
import orderRoutes from './routes/orders';
import inventoryRoutes from './routes/inventory';

const app = express();
const PORT = parseInt(process.env.PORT || '3000', 10);

app.use(express.json());

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// API routes
app.use('/api/orders', orderRoutes);
app.use('/api/inventory', inventoryRoutes);

// Global error handler
app.use(errorHandler);

app.listen(PORT, '0.0.0.0', () => {
  console.log(`ERP API server running on http://0.0.0.0:${PORT}`);
});

export default app;
