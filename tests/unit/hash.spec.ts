import { describe, it, expect } from 'vitest';
import { sha256Hex } from '../../src/main/util/hash';

describe('sha256Hex', () => {
  it('produces the known SHA-256 digest of a string', () => {
    // Well-known test vector: SHA-256("abc")
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('hashes a Buffer identically to the equivalent string', () => {
    expect(sha256Hex(Buffer.from('abc', 'utf8'))).toBe(sha256Hex('abc'));
  });

  it('is sensitive to every byte -- a single flipped byte changes the digest', () => {
    const original = Buffer.from([1, 2, 3, 4]);
    const tampered = Buffer.from([1, 2, 3, 5]);
    expect(sha256Hex(tampered)).not.toBe(sha256Hex(original));
  });
});
