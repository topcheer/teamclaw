// src/middleware/errorHandler.ts
import { Request, Response, NextFunction } from 'express';

export function errorHandler(
  err: Error,
  _req: Request,
  res: Response,
  _next: NextFunction
): void {
  console.error(`[ERROR] ${err.message}`, err.stack);

  const status = (err as any).status || 500;
  const message =
    status === 500 ? 'Internal server error' : err.message;

  res.status(status).json({
    success: false,
    error: message,
  });
}
