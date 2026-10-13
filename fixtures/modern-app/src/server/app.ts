import { Router } from './router';
import type { Handler } from './router';
import { listOrders, createOrder, health } from './handlers';

const logRequest: Handler = (req, _res) => {
  console.log(`${req.method} ${req.path}`);
};

export const buildApp = () => {
  const router = new Router();
  router.use(logRequest);
  router.get('/orders', listOrders);
  router.post('/orders', createOrder);
  router.get('/health', health);
  return router;
};
