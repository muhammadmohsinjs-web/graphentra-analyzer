export default function QuickBuyPage() {
  async function buy() {
    await fetch('/api/orders', { method: 'POST', body: JSON.stringify({ amount: 1 }) });
  }
  return <button onClick={buy}>Buy now</button>;
}
