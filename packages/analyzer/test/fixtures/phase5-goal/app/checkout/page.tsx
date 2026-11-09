export default function CheckoutPage() {
  async function pay() {
    await fetch('/api/orders', { method: 'POST', body: JSON.stringify({ amount: 10 }) });
  }
  return <button onClick={pay}>Pay</button>;
}
