export interface Req {
  method: string;
  path: string;
  body?: unknown;
  query?: Record<string, string>;
}

export interface Res {
  status(code: number): Res;
  json(data: unknown): void;
  send(text: string): void;
}

export type Handler = (req: Req, res: Res) => void;

export interface Route {
  method: 'GET' | 'POST';
  path: string;
  handler: Handler;
}

export class Router {
  readonly routes: Route[] = [];
  readonly middleware: Handler[] = [];

  get(path: string, h: Handler): this {
    this.routes.push({ method: 'GET', path, handler: h });
    return this;
  }

  post(path: string, h: Handler): this {
    this.routes.push({ method: 'POST', path, handler: h });
    return this;
  }

  use(h: Handler): this {
    this.middleware.push(h);
    return this;
  }

  dispatch(req: Req, res: Res): boolean {
    for (const m of this.middleware) m(req, res);
    const route = this.routes.find((r) => r.method === req.method && r.path === req.path);
    if (!route) return false;
    route.handler(req, res);
    return true;
  }
}
