import { beforeAll, describe, expect, it } from "bun:test";
import sodium from "libsodium-wrappers";

import {
  base64ToBytes,
  bytesToBase64,
  bytesToHex,
  decryptDocument,
  deriveAdminKeypairFromSignature,
  encryptDocument,
  extractEd25519SigBytes,
  generateDek,
  hexToBytes,
  kybDocHash,
  unwrapDek,
  wrapDek,
} from "../crypto";

beforeAll(async () => {
  await sodium.ready;
});

// ─────────────────────── encryptDocument / decryptDocument ────────────

describe("encryptDocument / decryptDocument", () => {
  it("roundtrips arbitrary bytes", () => {
    const dek = generateDek();
    const plaintext = new TextEncoder().encode("hello kyb world ".repeat(100));
    const { ciphertext, nonce } = encryptDocument(plaintext, dek);
    const recovered = decryptDocument(ciphertext, nonce, dek);
    expect(recovered).toEqual(plaintext);
  });

  it("ciphertext differs from plaintext", () => {
    const dek = generateDek();
    const plaintext = new Uint8Array(1024).fill(0x42);
    const { ciphertext } = encryptDocument(plaintext, dek);
    expect(ciphertext.slice(0, 100)).not.toEqual(plaintext.slice(0, 100));
    // GCM ciphertext is plaintext.length + 16-byte tag
    expect(ciphertext.length).toBe(plaintext.length + 16);
  });

  it("generates a unique nonce per call", () => {
    const dek = generateDek();
    const plaintext = new Uint8Array([1, 2, 3]);
    const a = encryptDocument(plaintext, dek);
    const b = encryptDocument(plaintext, dek);
    expect(a.nonce).not.toEqual(b.nonce);
    expect(a.ciphertext).not.toEqual(b.ciphertext);
  });

  it("decrypt with wrong DEK throws", () => {
    const dek = generateDek();
    const wrongDek = generateDek();
    const { ciphertext, nonce } = encryptDocument(new Uint8Array([7, 7, 7]), dek);
    expect(() => decryptDocument(ciphertext, nonce, wrongDek)).toThrow();
  });

  it("decrypt with tampered ciphertext throws", () => {
    const dek = generateDek();
    const plaintext = new Uint8Array(64).fill(0xab);
    const { ciphertext, nonce } = encryptDocument(plaintext, dek);
    const tampered = new Uint8Array(ciphertext);
    tampered[0] ^= 0x01;
    expect(() => decryptDocument(tampered, nonce, dek)).toThrow();
  });

  it("decrypt with tampered nonce throws", () => {
    const dek = generateDek();
    const plaintext = new Uint8Array([1, 2, 3, 4]);
    const { ciphertext, nonce } = encryptDocument(plaintext, dek);
    const tamperedNonce = new Uint8Array(nonce);
    tamperedNonce[0] ^= 0x01;
    expect(() => decryptDocument(ciphertext, tamperedNonce, dek)).toThrow();
  });

  it("rejects wrong-size DEK", () => {
    expect(() => encryptDocument(new Uint8Array([1]), new Uint8Array(16))).toThrow();
    expect(() =>
      decryptDocument(new Uint8Array(32), new Uint8Array(12), new Uint8Array(16)),
    ).toThrow();
  });

  it("rejects wrong-size nonce", () => {
    expect(() =>
      decryptDocument(new Uint8Array(32), new Uint8Array(8), generateDek()),
    ).toThrow();
  });
});

// ─────────────────────────── generateDek ──────────────────────────────

describe("generateDek", () => {
  it("returns 32 bytes", () => {
    expect(generateDek().length).toBe(32);
  });

  it("returns different DEKs on each call (entropy sanity)", () => {
    const set = new Set<string>();
    for (let i = 0; i < 100; i++) set.add(bytesToHex(generateDek()));
    expect(set.size).toBe(100);
  });
});

// ────────────────────────── wrapDek / unwrapDek ───────────────────────

describe("wrapDek / unwrapDek", () => {
  it("roundtrips the DEK with a freshly-generated X25519 keypair", async () => {
    const kp = sodium.crypto_box_keypair();
    const dek = generateDek();
    const wrapped = await wrapDek(dek, kp.publicKey);
    const unwrapped = await unwrapDek(wrapped, kp.privateKey, kp.publicKey);
    expect(unwrapped).toEqual(dek);
  });

  it("wrap output is 48 bytes longer than DEK (32 ephemeral pubkey + 16 MAC)", async () => {
    const kp = sodium.crypto_box_keypair();
    const dek = generateDek();
    const wrapped = await wrapDek(dek, kp.publicKey);
    expect(wrapped.length).toBe(dek.length + 48);
  });

  it("unwrap with wrong privkey throws", async () => {
    const kp1 = sodium.crypto_box_keypair();
    const kp2 = sodium.crypto_box_keypair();
    const dek = generateDek();
    const wrapped = await wrapDek(dek, kp1.publicKey);
    await expect(unwrapDek(wrapped, kp2.privateKey, kp1.publicKey)).rejects.toThrow();
  });

  it("unwrap of tampered wrapped bytes throws", async () => {
    const kp = sodium.crypto_box_keypair();
    const wrapped = await wrapDek(generateDek(), kp.publicKey);
    const tampered = new Uint8Array(wrapped);
    tampered[tampered.length - 1] ^= 0x01;
    await expect(unwrapDek(tampered, kp.privateKey, kp.publicKey)).rejects.toThrow();
  });

  it("rejects wrong-size pubkey", async () => {
    const kp = sodium.crypto_box_keypair();
    await expect(wrapDek(generateDek(), new Uint8Array(16))).rejects.toThrow();
    await expect(
      unwrapDek(new Uint8Array(80), kp.privateKey, new Uint8Array(16)),
    ).rejects.toThrow();
  });
});

// ──────────────────────────── kybDocHash ──────────────────────────────

describe("kybDocHash", () => {
  it("returns 32 bytes", () => {
    expect(kybDocHash(new Uint8Array([1, 2, 3])).length).toBe(32);
  });

  it("is deterministic for identical input", () => {
    const a = kybDocHash(new TextEncoder().encode("same input"));
    const b = kybDocHash(new TextEncoder().encode("same input"));
    expect(a).toEqual(b);
  });

  it("differs for different input", () => {
    const a = kybDocHash(new TextEncoder().encode("a"));
    const b = kybDocHash(new TextEncoder().encode("b"));
    expect(a).not.toEqual(b);
  });
});

// ──────────────────────── extractEd25519SigBytes ──────────────────────

describe("extractEd25519SigBytes", () => {
  it("strips flag + pubkey from a well-formed Sui signPersonalMessage output", () => {
    // Construct a synthetic 97-byte Sui sig: [0x00 || 64 bytes sig || 32 bytes pubkey]
    const sig64 = new Uint8Array(64);
    for (let i = 0; i < 64; i++) sig64[i] = i + 1;
    const pubkey = new Uint8Array(32).fill(0xaa);
    const composed = new Uint8Array(97);
    composed[0] = 0x00; // ed25519 flag
    composed.set(sig64, 1);
    composed.set(pubkey, 65);
    const b64 = bytesToBase64(composed);

    const extracted = extractEd25519SigBytes(b64);
    expect(extracted.length).toBe(64);
    expect(extracted).toEqual(sig64);
  });

  it("rejects non-ed25519 scheme flags", () => {
    const composed = new Uint8Array(97);
    composed[0] = 0x05; // zkLogin scheme flag
    const b64 = bytesToBase64(composed);
    expect(() => extractEd25519SigBytes(b64)).toThrow(/ed25519/);
  });

  it("rejects wrong-length signatures", () => {
    expect(() => extractEd25519SigBytes(bytesToBase64(new Uint8Array(50)))).toThrow();
    expect(() => extractEd25519SigBytes(bytesToBase64(new Uint8Array(120)))).toThrow();
  });
});

// ─────────────────── deriveAdminKeypairFromSignature ──────────────────

describe("deriveAdminKeypairFromSignature", () => {
  it("is deterministic — same signature in produces same keypair out", async () => {
    const sig = new Uint8Array(64);
    for (let i = 0; i < 64; i++) sig[i] = (i * 7) & 0xff;
    const a = await deriveAdminKeypairFromSignature(sig);
    const b = await deriveAdminKeypairFromSignature(sig);
    expect(a.x25519PrivKey).toEqual(b.x25519PrivKey);
    expect(a.x25519PubKey).toEqual(b.x25519PubKey);
  });

  it("different signatures produce different keypairs", async () => {
    const sigA = new Uint8Array(64).fill(0x01);
    const sigB = new Uint8Array(64).fill(0x02);
    const a = await deriveAdminKeypairFromSignature(sigA);
    const b = await deriveAdminKeypairFromSignature(sigB);
    expect(a.x25519PrivKey).not.toEqual(b.x25519PrivKey);
    expect(a.x25519PubKey).not.toEqual(b.x25519PubKey);
  });

  it("priv key is RFC 7748 clamped", async () => {
    const sig = new Uint8Array(64).fill(0xff);
    const { x25519PrivKey } = await deriveAdminKeypairFromSignature(sig);
    // Low 3 bits of byte 0 cleared
    expect(x25519PrivKey[0] & 0b00000111).toBe(0);
    // Bit 7 of byte 31 cleared
    expect(x25519PrivKey[31] & 0b10000000).toBe(0);
    // Bit 6 of byte 31 set
    expect(x25519PrivKey[31] & 0b01000000).toBe(0b01000000);
  });

  it("pub key is the correct X25519 derivation of priv", async () => {
    const sig = new Uint8Array(64);
    for (let i = 0; i < 64; i++) sig[i] = i;
    const { x25519PrivKey, x25519PubKey } = await deriveAdminKeypairFromSignature(sig);
    const expectedPub = sodium.crypto_scalarmult_base(x25519PrivKey);
    expect(x25519PubKey).toEqual(expectedPub);
  });

  it("pub key is not zero or curve identity", async () => {
    const sig = new Uint8Array(64).fill(0x42);
    const { x25519PubKey } = await deriveAdminKeypairFromSignature(sig);
    const allZero = new Uint8Array(32);
    expect(x25519PubKey).not.toEqual(allZero);
  });

  it("rejects wrong-size signature", async () => {
    await expect(deriveAdminKeypairFromSignature(new Uint8Array(32))).rejects.toThrow();
    await expect(deriveAdminKeypairFromSignature(new Uint8Array(100))).rejects.toThrow();
  });
});

// ──────────────────────────── End-to-end ──────────────────────────────

describe("end-to-end roundtrip (the single highest-value test)", () => {
  it("merchant encrypts + wraps → admin (same wallet signature) unwraps + decrypts", async () => {
    // ── ADMIN SETUP (one-time) ──
    // Simulate the admin's wallet producing a deterministic ed25519 signature
    // over the derive-key message. (In real use this comes from
    // signPersonalMessage("QUAY_KYB_DECRYPT_KEY_V1").)
    const adminSig = new Uint8Array(64);
    for (let i = 0; i < 64; i++) adminSig[i] = (i * 13 + 7) & 0xff;
    const adminKp1 = await deriveAdminKeypairFromSignature(adminSig);
    // Public key gets pasted into ADMIN_KYB_PUBKEY env var.
    const adminPubKey = adminKp1.x25519PubKey;

    // ── MERCHANT SUBMIT (browser) ──
    const docPlaintext = new TextEncoder().encode(
      "BIZFILE EXTRACT\nUEN: 12345678X\nACME PTE LTD\n".repeat(50),
    );
    const dek = generateDek();
    const { ciphertext, nonce } = encryptDocument(docPlaintext, dek);
    const wrappedDek = await wrapDek(dek, adminPubKey);
    const docHash = kybDocHash(docPlaintext);

    // ── TRANSMIT (would be JSON over the wire) ──
    const wirePayload = {
      ciphertext_b64: bytesToBase64(ciphertext),
      nonce_b64: bytesToBase64(nonce),
      wrapped_dek_b64: bytesToBase64(wrappedDek),
      kyb_doc_hash_hex: bytesToHex(docHash),
    };

    // ── ADMIN REVIEW (later session, same wallet signs again) ──
    // Same signature → derives the same keypair, no key storage needed.
    const adminKp2 = await deriveAdminKeypairFromSignature(adminSig);
    expect(adminKp2.x25519PubKey).toEqual(adminPubKey); // sanity: derive is stable

    const recoveredCiphertext = base64ToBytes(wirePayload.ciphertext_b64);
    const recoveredNonce = base64ToBytes(wirePayload.nonce_b64);
    const recoveredWrappedDek = base64ToBytes(wirePayload.wrapped_dek_b64);

    const recoveredDek = await unwrapDek(
      recoveredWrappedDek,
      adminKp2.x25519PrivKey,
      adminKp2.x25519PubKey,
    );
    const recoveredPlaintext = decryptDocument(recoveredCiphertext, recoveredNonce, recoveredDek);

    expect(recoveredPlaintext).toEqual(docPlaintext);
    // And the doc hash from plaintext matches the wire commitment
    expect(bytesToHex(kybDocHash(recoveredPlaintext))).toBe(wirePayload.kyb_doc_hash_hex);
  });

  it("admin signing the wrong message produces a different key that cannot unwrap", async () => {
    const rightSig = new Uint8Array(64).fill(0x55);
    const wrongSig = new Uint8Array(64).fill(0x66);
    const right = await deriveAdminKeypairFromSignature(rightSig);
    const wrong = await deriveAdminKeypairFromSignature(wrongSig);

    const dek = generateDek();
    const wrapped = await wrapDek(dek, right.x25519PubKey);

    await expect(
      unwrapDek(wrapped, wrong.x25519PrivKey, right.x25519PubKey),
    ).rejects.toThrow();
  });
});

// ─────────────────────────── Encoding helpers ─────────────────────────

describe("hex / base64 encoding helpers", () => {
  it("hex roundtrip", () => {
    const b = new Uint8Array([0x00, 0x7f, 0xff, 0xab, 0xcd]);
    expect(hexToBytes(bytesToHex(b))).toEqual(b);
  });

  it("base64 roundtrip", () => {
    const b = new Uint8Array([0x00, 0x01, 0x02, 0xff, 0xfe, 0xfd]);
    expect(base64ToBytes(bytesToBase64(b))).toEqual(b);
  });

  it("hexToBytes rejects odd-length input", () => {
    expect(() => hexToBytes("abc")).toThrow();
  });
});
