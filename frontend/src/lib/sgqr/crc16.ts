/**
 * CRC-16-CCITT-FALSE (poly=0x1021, init=0xFFFF, refin=false, refout=false,
 * xorout=0x0000) — the variant required by EMVCo MPM (and therefore SGQR).
 *
 * Computed over the ASCII bytes of the QR payload up to and including the
 * literal "6304" tag+length prefix that begins the CRC field. The trailing
 * 4 ASCII characters are the CRC's uppercase hex representation.
 *
 * Test vectors (kept inline so tests can cross-check the algorithm itself):
 *   "123456789" → 0x29B1
 *   ""          → 0xFFFF
 */
export function crc16CcittFalse(bytes: Uint8Array): number {
  let crc = 0xffff;
  for (let i = 0; i < bytes.length; i++) {
    crc ^= (bytes[i] & 0xff) << 8;
    for (let bit = 0; bit < 8; bit++) {
      if ((crc & 0x8000) !== 0) {
        crc = ((crc << 1) ^ 0x1021) & 0xffff;
      } else {
        crc = (crc << 1) & 0xffff;
      }
    }
  }
  return crc & 0xffff;
}

/** Convenience: compute CRC over a UTF-8 string. */
export function crc16OfString(s: string): number {
  return crc16CcittFalse(new TextEncoder().encode(s));
}

/** Format as uppercase 4-hex-character string (e.g., 0x29B1 → "29B1"). */
export function crcToHex4(crc: number): string {
  return (crc & 0xffff).toString(16).toUpperCase().padStart(4, "0");
}
