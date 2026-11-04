/**
 * Konami-style key sequence listener, matched on KeyboardEvent.code. It compares the last N keys against the
 * sequence, so a stumble ("↑ ↑ ↑ ↓ ↓…") still lands, and a pause longer than `gapMs` starts it over.
 */
export class SecretCode {
  private buf: string[] = [];
  private lastAt = 0;

  constructor(
    private sequence: readonly string[],
    private onMatch: () => void,
    private opts: { gapMs?: number; enabled?: () => boolean } = {},
  ) {
    window.addEventListener('keydown', (e) => this.onKey(e));
  }

  private onKey(e: KeyboardEvent) {
    if (e.repeat || e.ctrlKey || e.metaKey || e.altKey || this.opts.enabled?.() === false) return;
    if (e.timeStamp - this.lastAt > (this.opts.gapMs ?? 3000)) this.buf.length = 0;
    this.lastAt = e.timeStamp;
    this.buf.push(e.code);
    if (this.buf.length > this.sequence.length) this.buf.shift();
    if (this.buf.length === this.sequence.length && this.buf.every((c, i) => c === this.sequence[i])) {
      this.buf.length = 0;
      this.onMatch();
    }
  }
}
