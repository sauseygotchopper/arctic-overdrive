import specialData from '../data/special.json';

/** Scauce, the Special Delivery contact: an original cartoon portrait (inline SVG) and his lines. */
export const SCAUCE = specialData.contact;

export const SCAUCE_PORTRAIT = `<img class="scauce-portrait" src="/src/assets/scauce-portrait.webp" alt="${SCAUCE.name}">`;

/** Fill in {name}-style placeholders in his lines. */
export function scauceSays(line: string, vars: Record<string, string> = {}): string {
  return line.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? '');
}
