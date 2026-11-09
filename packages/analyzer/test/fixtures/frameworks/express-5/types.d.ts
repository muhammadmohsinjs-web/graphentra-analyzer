declare module 'express' {
  export interface Request { params: Record<string, string>; body: any; headers: Record<string, string | undefined> }
  export interface Response { status(code: number): Response; json(body: unknown): void; send(body: string): void }
  export type NextFunction = (error?: unknown) => void;
  export type Handler = (req: Request, res: Response, next: NextFunction) => void;
  export interface Router {
    get(path: string, ...handlers: Handler[]): Router;
    post(path: string, ...handlers: Handler[]): Router;
    use(...args: unknown[]): Router;
  }
  export interface Application extends Router { listen(port: number): void }
  interface Express { (): Application; Router(): Router; json(): Handler }
  const express: Express;
  export default express;
}
