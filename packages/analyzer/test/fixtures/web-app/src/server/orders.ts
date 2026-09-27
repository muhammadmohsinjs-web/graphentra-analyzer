import { Router } from 'express';
import { createOrder, getOrder } from './orderService';

function requireAuth(req: any, res: any, next: () => void) {
  if (!req.user) return res.status(401).json({ message: 'Please sign in' });
  next();
}

const router = Router();
router.post('/', requireAuth, createOrder);
router.get('/:id', requireAuth, getOrder);

export default router;
