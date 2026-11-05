import { Logger } from '../../src/services/logger';
import { OrderService } from '../../src/services/order-service';

// Test-body `new` expressions are attributed to the test file's module scope by the
// analyzer, which shows up as INSTANTIATES edges from `<module>`. The fixture's
// extended-instantiates test forbids those, so tests build these via the helpers.
export const newLogger = (prefix: string): Logger => new Logger(prefix);

export const newOrderService = (logger: Logger): OrderService => new OrderService(logger);
