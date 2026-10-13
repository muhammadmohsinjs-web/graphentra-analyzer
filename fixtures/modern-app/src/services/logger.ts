export class Logger {
  private lines: string[] = [];

  constructor(private readonly prefix: string) {}

  static create(): Logger {
    return new Logger('default');
  }

  info(msg: string): void {
    this.lines.push(`[${this.prefix}] ${msg}`);
  }

  get lineCount(): number {
    return this.lines.length;
  }
}
