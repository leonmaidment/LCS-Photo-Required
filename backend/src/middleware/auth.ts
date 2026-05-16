import { Request, Response, NextFunction } from 'express';
import { config } from '../config';

/**
 * Lightweight auth gate for MVP. The mobile app sends the shared
 * secret as `Authorization: Bearer <APP_SHARED_SECRET>`. Replace this
 * with proper JWT/SSO before production rollout.
 */
export function requireSharedSecret(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token || token !== config.auth.sharedSecret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}
