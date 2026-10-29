import specialData from '../data/special.json';

/** Scauce, the Special Delivery contact: an original cartoon portrait (inline SVG) and his lines. */
export const SCAUCE = specialData.contact;

export const SCAUCE_PORTRAIT = `
<svg class="scauce-portrait" viewBox="0 0 200 220" xmlns="http://www.w3.org/2000/svg" aria-label="${SCAUCE.name}">
  <defs>
    <linearGradient id="sc-bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2a3d5c"/><stop offset="1" stop-color="#0f1a2c"/></linearGradient>
    <linearGradient id="sc-jacket" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1d2433"/><stop offset="1" stop-color="#0b0f17"/></linearGradient>
  </defs>
  <rect width="200" height="220" rx="18" fill="url(#sc-bg)"/>
  <!-- puffer jacket -->
  <path d="M22 220 C26 170 52 150 100 148 C148 150 174 170 178 220 Z" fill="url(#sc-jacket)"/>
  <path d="M40 182 Q100 172 160 182 M32 202 Q100 190 168 202" stroke="#2c3648" stroke-width="3" fill="none"/>
  <path d="M100 150 L100 220" stroke="#3a4558" stroke-width="2"/>
  <!-- neck + chain -->
  <path d="M82 128 L118 128 L120 156 Q100 166 80 156 Z" fill="#f0c3a1"/>
  <path d="M78 152 Q100 172 122 152" stroke="#e6c35a" stroke-width="3.5" fill="none" stroke-linecap="round"/>
  <!-- ears -->
  <ellipse cx="54" cy="96" rx="9" ry="13" fill="#eab896"/>
  <ellipse cx="146" cy="96" rx="9" ry="13" fill="#eab896"/>
  <!-- head -->
  <path d="M56 84 C56 50 76 36 100 36 C124 36 144 50 144 84 L144 100 C144 128 124 142 100 142 C76 142 56 128 56 100 Z" fill="#f3c7a5"/>
  <!-- ginger crop under a backwards cap -->
  <path d="M56 80 C54 56 70 40 100 39 C130 40 146 56 144 80 C136 66 120 60 100 60 C80 60 64 66 56 80 Z" fill="#d9662b"/>
  <path d="M58 70 C60 42 80 30 100 30 C120 30 140 42 142 70 C128 58 116 54 100 54 C84 54 72 58 58 70 Z" fill="#c8d2df"/>
  <path d="M62 64 C62 46 80 36 100 36" stroke="#e8eef5" stroke-width="3" fill="none" stroke-linecap="round"/>
  <rect x="88" y="30" width="24" height="6" rx="3" fill="#9aa6b6"/>
  <path d="M132 62 C146 60 158 66 160 74 C150 74 140 72 132 70 Z" fill="#aab5c4"/>
  <!-- sideburns -->
  <path d="M57 86 L62 86 L62 104 L58 100 Z M143 86 L138 86 L138 104 L142 100 Z" fill="#c95a24"/>
  <!-- eyebrows: one cocked -->
  <path d="M70 78 Q80 70 91 76" stroke="#b9501f" stroke-width="5" fill="none" stroke-linecap="round"/>
  <path d="M109 74 Q121 66 131 74" stroke="#b9501f" stroke-width="5" fill="none" stroke-linecap="round"/>
  <!-- eyes, a cheeky squint -->
  <path d="M72 89 Q81 83 90 89 Q81 93 72 89 Z" fill="#fff"/>
  <circle cx="82" cy="88.5" r="3.6" fill="#3d6b3a"/>
  <path d="M110 88 Q120 81 130 88 Q120 93 110 88 Z" fill="#fff"/>
  <circle cx="120" cy="87.5" r="3.6" fill="#3d6b3a"/>
  <!-- nose -->
  <path d="M100 92 L95 110 Q100 114 106 110" stroke="#d99f7d" stroke-width="3" fill="none" stroke-linecap="round"/>
  <!-- freckles -->
  <g fill="#d48a5c"><circle cx="78" cy="104" r="1.6"/><circle cx="84" cy="108" r="1.4"/><circle cx="73" cy="109" r="1.3"/><circle cx="122" cy="104" r="1.6"/><circle cx="116" cy="108" r="1.4"/><circle cx="127" cy="109" r="1.3"/></g>
  <!-- big grin with a gold tooth -->
  <path d="M78 116 Q100 140 124 116 Q100 124 78 116 Z" fill="#5a1f1a"/>
  <path d="M81 117 Q100 124 121 117 L119 122 Q100 128 83 122 Z" fill="#fff"/>
  <rect x="104" y="119" width="6" height="5" rx="1" fill="#e6c35a"/>
  <path d="M76 114 Q78 118 80 116 M126 114 Q124 118 122 116" stroke="#c98e6e" stroke-width="2" fill="none" stroke-linecap="round"/>
</svg>`;

/** Fill in {name}-style placeholders in his lines. */
export function scauceSays(line: string, vars: Record<string, string> = {}): string {
  return line.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? '');
}
