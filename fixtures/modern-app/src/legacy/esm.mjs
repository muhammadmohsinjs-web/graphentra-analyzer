// ES module: arrow and plain function exports, one calling into the TypeScript utilities.
import { formatPrice } from '../utils/format';

export const describePrice = (n) => `Price: ${formatPrice(n)}`;

export function describeAll(values) {
  return values.map(describePrice);
}
