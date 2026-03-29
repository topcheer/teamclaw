import type { Request, Response, NextFunction } from 'express';

/** 标准化 API 错误 */
export class ApiError extends Error {
  constructor(
    public statusCode: number,
    message: string,
    public details?: unknown
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** 全局错误处理中间件 */
export function errorHandler(err: Error, _req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof ApiError) {
    res.status(err.statusCode).json({
      success: false,
      error: { message: err.message, details: err.details },
    });
    return;
  }
  console.error('Unhandled error:', err);
  res.status(500).json({
    success: false,
    error: { message: 'Internal server error' },
  });
}

/** 请求校验中间件工厂 */
export function validateBody(schema: { parse: (data: unknown) => unknown }) {
  return (req: Request, _res: Response, next: NextFunction) => {
    try {
      req.body = schema.parse(req.body);
      next();
    } catch (err: unknown) {
      const zodErr = err as { errors?: Array<{ message: string; path: string[] }> };
      next(new ApiError(400, 'Validation failed', zodErr.errors));
    }
  };
}

export function validateQuery(schema: { parse: (data: unknown) => unknown }) {
  return (req: Request, _res: Response, next: NextFunction) => {
    try {
      req.query = schema.parse(req.query) as any;
      next();
    } catch (err: unknown) {
      const zodErr = err as { errors?: Array<{ message: string; path: string[] }> };
      next(new ApiError(400, 'Invalid query parameters', zodErr.errors));
    }
  };
}
