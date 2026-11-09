import express from 'express';
import { requireAuth } from './auth';
import { createOrderHandler, getOrder } from './orderHandlers';
import { findOrder } from './orderService';

const app = express();
const router = express.Router();

app.get('/health', (_req, res) => {
  res.send('ok');
});

app.post('/login', express.json(), (req, res) => {
  res.json({ user: req.body.user });
});

router.get('/orders/:id', requireAuth, getOrder);
router.post('/orders', requireAuth, createOrderHandler);
router.get('/orders/:id/summary', (req, res) => {
  res.json(findOrder(req.params.id));
});

app.use('/api', router);

app.listen(3000);
