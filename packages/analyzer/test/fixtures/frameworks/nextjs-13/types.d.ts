declare module 'next/server' {
  export class NextResponse extends Response {
    static json(body: unknown, init?: { status?: number }): NextResponse;
  }
}
