import { Request, Response, NextFunction } from 'express';
import { AppError } from '../types';

export function errorHandler(
  err: Error | AppError,
  _req: Request,
  res: Response,
  _next: NextFunction
): void {
  if (err instanceof AppError) {
    res.status(err.statusCode).json({
      error: {
        code: err.statusCode,
        message: err.message,
        details: err.details,
      },
    });
    return;
  }

  console.error('Unhandled error:', err);
  res.status(500).json({
    error: {
      code: 500,
      message: 'Internal server error',
    },
  });
}

export function validateBody<T>(requiredKeys: string[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const body = req.body;
    const missing = requiredKeys.filter((key) => body[key] === undefined);
    if (missing.length > 0) {
      next(new AppError(400, `Missing required fields: ${missing.join(', ')}`));
      return;
    }
    next();
  };
}

export async function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<void>
): Promise<(req: Request, res: Response, next: NextFunction) => void> {
  return (req, res, next) => fn(req, res, next).catch(next);
}
