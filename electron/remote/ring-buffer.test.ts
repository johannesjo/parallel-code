import { describe, expect, it } from 'vitest';
import { RingBuffer } from './ring-buffer.js';

describe('RingBuffer', () => {
  it('defaults to 64 KB capacity', () => {
    // Every PTY allocates one up front; phones get history from the mirror instead.
    const rb = new RingBuffer();
    expect(rb.length).toBe(0);
    rb.write(Buffer.alloc(1024 * 1024, 'a'));
    expect(rb.length).toBe(64 * 1024);
  });

  it('reads back appended data in order', () => {
    const rb = new RingBuffer(64);
    rb.write(Buffer.from('hello '));
    rb.write(Buffer.from('world'));
    expect(rb.read().toString('utf8')).toBe('hello world');
    expect(rb.length).toBe(11);
  });

  it('wraps around and retains the latest bytes when capacity is exceeded', () => {
    const rb = new RingBuffer(10);
    rb.write(Buffer.from('0123456789'));
    expect(rb.read().toString('utf8')).toBe('0123456789');
    expect(rb.length).toBe(10);

    rb.write(Buffer.from('abc'));
    expect(rb.read().toString('utf8')).toBe('3456789abc');
    expect(rb.length).toBe(10);
  });

  it('handles write larger than capacity by keeping tail', () => {
    const rb = new RingBuffer(5);
    rb.write(Buffer.from('0123456789'));
    expect(rb.read().toString('utf8')).toBe('56789');
    expect(rb.length).toBe(5);
  });

  it('converts to base64 correctly', () => {
    const rb = new RingBuffer(32);
    rb.write(Buffer.from('test data'));
    expect(rb.toBase64()).toBe(Buffer.from('test data').toString('base64'));
  });

  it('clears correctly', () => {
    const rb = new RingBuffer(32);
    rb.write(Buffer.from('temporary'));
    expect(rb.length).toBe(9);
    rb.clear();
    expect(rb.length).toBe(0);
    expect(rb.read().length).toBe(0);
  });
});
