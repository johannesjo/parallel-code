/** Fixed-capacity ring buffer for terminal scrollback replay. */
export class RingBuffer {
  private buf: Buffer;
  private pos = 0;
  private full = false;

  constructor(private readonly capacity: number = 2 * 1024 * 1024) {
    this.buf = Buffer.alloc(capacity);
  }

  /** Append data to the ring buffer. */
  write(data: Buffer): void {
    if (data.length >= this.capacity) {
      // Data larger than buffer — keep only the tail
      data.copy(this.buf, 0, data.length - this.capacity);
      this.pos = 0;
      this.full = true;
      return;
    }

    const spaceAtEnd = this.capacity - this.pos;
    if (data.length <= spaceAtEnd) {
      data.copy(this.buf, this.pos);
    } else {
      data.copy(this.buf, this.pos, 0, spaceAtEnd);
      data.copy(this.buf, 0, spaceAtEnd);
    }

    this.pos = (this.pos + data.length) % this.capacity;
    if (!this.full && this.pos < data.length) this.full = true;
  }

  /** Read all buffered data in chronological order (returns a copy). */
  read(): Buffer {
    if (!this.full) return Buffer.from(this.buf.subarray(0, this.pos));
    return Buffer.concat([this.buf.subarray(this.pos), this.buf.subarray(0, this.pos)]);
  }

  /** Return buffered data as a base64 string. */
  toBase64(): string {
    return this.read().toString('base64');
  }

  /** Number of bytes currently stored. */
  get length(): number {
    return this.full ? this.capacity : this.pos;
  }

  /** Reset the buffer. */
  clear(): void {
    this.pos = 0;
    this.full = false;
  }
}
