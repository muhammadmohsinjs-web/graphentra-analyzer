export async function placeOrder(cartId: string, cardToken: string): Promise<boolean> {
  const response = await fetch('/api/orders', {
    method: 'POST',
    body: JSON.stringify({ cartId, cardToken }),
  });
  return response.ok;
}
