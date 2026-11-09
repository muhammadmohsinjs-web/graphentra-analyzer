import { NextResponse } from 'next/server';
import { createOrder, listOrders } from '../../../lib/orders';

export async function GET() {
  return NextResponse.json(listOrders());
}

export async function POST(request: Request) {
  const body = (await request.json()) as { amount: number };
  return NextResponse.json(createOrder(body.amount), { status: 201 });
}
