export function greet(name: string): string {
  return `Hello, ${name.trim()}!`;
}

export function greetAll(names: string[]): string[] {
  return names.map(name => greet(name));
}
