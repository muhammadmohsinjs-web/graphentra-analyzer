import type { Request, Response } from 'express';
import { findOrder, placeOrder } from './orderService';

export function getOrder(req: Request, res: Response): void {
  res.json(findOrder(req.params.id));
}

export function createOrderHandler(req: Request, res: Response): void {
  res.status(201).json(placeOrder(req.body.amount));
}
