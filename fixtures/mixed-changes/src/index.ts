import { greetAll } from './greeting';

export function main(): string {
  return greetAll(['Ada', 'Grace']).join('\n');
}
