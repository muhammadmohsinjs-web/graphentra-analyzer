import express from 'express';
import ordersRouter from './orders';

export function createApp() {
  const app = express();
  app.use('/api/orders', ordersRouter);
  return app;
}
