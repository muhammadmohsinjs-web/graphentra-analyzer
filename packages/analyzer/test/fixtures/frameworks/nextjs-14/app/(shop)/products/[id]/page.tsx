import { describeProduct } from '../../../../lib/orders';

export default function ProductPage(props: { params: { id: string } }) {
  return describeProduct(props.params.id);
}
