/// quay::payments — SGQR-compatible Sui payments.
///
/// The trust root is a single ed25519 issuer pubkey held by quay (V0).
/// Merchants register by presenting an attestation signed by the issuer
/// over a canonical BCS-encoded message including their UEN, claimer
/// address, nonce, chain_id, and expiry. Payments emit a typed
/// PaymentReceipt event for off-chain indexing. Refunds emit a
/// RefundIssued event linked to the original receipt_id.
///
/// Decision audit references:
///   AD19: BCS-struct canonical attestation message
///   AD20: capture merchant Sui address before signing (off-chain workflow)
///   AD21: init-race guard E_REGISTRY_NOT_INITIALIZED
///   AD22: expires_at_ms on attestation + clock check
///   AD23: PaymentReceipt.sgd_minor_units + quote_metadata
///   AD24: chain_id in canonical attestation (cross-network replay)
///
/// Domain tags:
///   b"PAYNOW_UEN_V1" — registry key derivation (room for future
///                     mobile-number proxies via PAYNOW_MOBILE_V1)
///   b"QUAY_CLAIM_V1" — canonical attestation message
module quay::payments;

use std::string::String;
use std::type_name::{Self, TypeName};
use sui::bcs;
use sui::clock::{Self, Clock};
use sui::coin::{Self, Coin};
use sui::ed25519;
use sui::event;
use sui::hash;
use sui::table::{Self, Table};

// ─── Errors ─────────────────────────────────────────────────────────────
const E_UEN_ALREADY_CLAIMED: u64 = 1;
const E_UEN_NOT_REGISTERED: u64 = 2;
const E_NOT_MERCHANT_OWNER: u64 = 3;
const E_PAYMENT_BELOW_MIN: u64 = 4;
const E_INVALID_ATTESTATION: u64 = 5;
const E_NONCE_REPLAYED: u64 = 6;
const E_NOT_ADMIN: u64 = 7;
const E_REGISTRY_NOT_INITIALIZED: u64 = 8;
const E_ATTESTATION_EXPIRED: u64 = 9;
const E_ISSUER_ALREADY_SET: u64 = 11;
const E_REFUND_AMOUNT_ZERO: u64 = 12;
// const 10 deliberately skipped — see note below.

// Note: chain_id mismatch surfaces as E_INVALID_ATTESTATION (the ed25519
// verification fails because the BCS message uses the wrong chain_id),
// so no dedicated error code is needed.

// ─── State ──────────────────────────────────────────────────────────────

/// Shared singleton registry. Created in `init`.
public struct MerchantRegistry has key {
    id: UID,
    /// 32-byte ed25519 pubkey of the quay attestation issuer.
    /// Empty until `set_initial_issuer_pubkey` is called by admin.
    issuer_pubkey: vector<u8>,
    /// Chain identifier baked into attestations to prevent cross-network replay.
    /// Set at init from the deployer's intent (e.g., 1 = mainnet, 0 = testnet).
    chain_id: u8,
    admin: address,
    /// key = blake2b256(b"PAYNOW_UEN_V1" || uen_bytes)
    entries: Table<vector<u8>, MerchantEntry>,
    /// Replay-prevention for attestation nonces. Set true once consumed.
    used_nonces: Table<vector<u8>, bool>,
}

/// One entry per claimed UEN. Key = uen_hash (in the table); raw UEN bytes
/// duplicated here so the terminal can recover the human-readable UEN on any
/// device without storing it in a side channel.
public struct MerchantEntry has store {
    sui_address: address,
    claimed_at_ms: u64,
    /// Raw UEN bytes (8-10 ASCII chars). Lets `/merchant/terminal` and
    /// `/m/<uen>` show the UEN that produced this entry without reversing
    /// the one-way blake2b key hash.
    uen_raw: vector<u8>,
    /// Walrus blob ID (string) for the merchant's profile (logo). Frontend
    /// builds the aggregator URL `${WALRUS_AGGREGATOR_URL}/v1/${blobId}` on
    /// read. Optional — onboarding may proceed without a logo per D7.
    metadata_uri: Option<String>,
    /// blake2b256 of the issuer-verified evidence content (e.g., signed
    /// merchant form snapshot). The Walrus blob ID for the evidence itself
    /// lives in the operator's audit log keyed by this hash. On-chain
    /// reference proves the issuer signed off after reviewing specific
    /// evidence.
    evidence_hash: vector<u8>,
}

/// AdminCap — separate object holder, transferable. Used for rotating the
/// issuer pubkey without redeploying the contract.
public struct AdminCap has key, store {
    id: UID,
}

/// Canonical attestation message (BCS-encoded, then blake2b256 hashed)
/// AD19 — explicit struct shape, deterministic across SDKs.
public struct ClaimMessage has copy, drop {
    domain_tag: vector<u8>,   // b"QUAY_CLAIM_V1"
    chain_id: u8,             // AD24
    uen: vector<u8>,
    claimer: address,         // AD20: the Sui address that will hold the entry
    nonce: vector<u8>,
    expires_at_ms: u64,       // AD22
    /// blake2b256(evidence_bytes). Binds the issuer's signature to specific
    /// evidence content (off-chain JSON / form snapshot stored on Walrus).
    /// Re-uploads don't break verification because the hash binds to content,
    /// not the Walrus blob ID.
    evidence_hash: vector<u8>,
}

// ─── Events ─────────────────────────────────────────────────────────────

public struct MerchantRegistered has copy, drop {
    uen_hash: vector<u8>,
    sui_address: address,
    timestamp_ms: u64,
}

public struct PaymentReceipt has copy, drop {
    receipt_id: vector<u8>,
    merchant: address,
    payer: address,
    amount: u64,
    token_type: TypeName,
    uen_hash: vector<u8>,
    timestamp_ms: u64,
    memo: Option<vector<u8>>,
    /// AD23: SGD-equivalent amount in minor units (e.g., $1.50 SGD = 150).
    /// Always populated; if Pyth FX feed unavailable, frontend may set to 0
    /// and signal in `quote_metadata`.
    sgd_minor_units: u64,
    /// AD23: BCS-serialized quote inputs (Pyth feed IDs + prices, Cetus
    /// pool ID + tick, slippage applied). Enables merchants and auditors to
    /// reproduce the SGD computation off-chain.
    quote_metadata: Option<vector<u8>>,
}

public struct RefundIssued has copy, drop {
    original_receipt_id: vector<u8>,
    merchant: address,
    payer: address,
    amount: u64,
    token_type: TypeName,
    timestamp_ms: u64,
}

public struct IssuerKeyRotated has copy, drop {
    old_pubkey: vector<u8>,
    new_pubkey: vector<u8>,
    timestamp_ms: u64,
}

public struct MerchantAddressUpdated has copy, drop {
    uen_hash: vector<u8>,
    old_address: address,
    new_address: address,
    timestamp_ms: u64,
}

public struct MerchantMetadataUpdated has copy, drop {
    uen_hash: vector<u8>,
    new_metadata_uri: Option<String>,
    timestamp_ms: u64,
}

// ─── Init ───────────────────────────────────────────────────────────────

/// Called once at module publish.
fun init(ctx: &mut TxContext) {
    let admin = ctx.sender();
    transfer::share_object(MerchantRegistry {
        id: object::new(ctx),
        issuer_pubkey: vector[],
        chain_id: 0,
        admin,
        entries: table::new(ctx),
        used_nonces: table::new(ctx),
    });
    transfer::public_transfer(AdminCap { id: object::new(ctx) }, admin);
}

/// One-time admin setter: initial issuer pubkey + chain_id. After this runs,
/// rotation must use AdminCap (the AdminCap is what authorizes mainline
/// rotation; chain_id is permanent for the deployed instance).
public fun set_initial_issuer_pubkey(
    registry: &mut MerchantRegistry,
    pubkey: vector<u8>,
    chain_id: u8,
    ctx: &mut TxContext,
) {
    assert!(ctx.sender() == registry.admin, E_NOT_ADMIN);
    assert!(vector::is_empty(&registry.issuer_pubkey), E_ISSUER_ALREADY_SET);
    registry.issuer_pubkey = pubkey;
    registry.chain_id = chain_id;
}

/// Rotate the issuer pubkey. AdminCap must be held by caller.
public fun rotate_issuer_pubkey(
    _cap: &AdminCap,
    registry: &mut MerchantRegistry,
    new_pubkey: vector<u8>,
    clock: &Clock,
) {
    let old = registry.issuer_pubkey;
    registry.issuer_pubkey = new_pubkey;
    event::emit(IssuerKeyRotated {
        old_pubkey: old,
        new_pubkey,
        timestamp_ms: clock::timestamp_ms(clock),
    });
}

// ─── Internal helpers ───────────────────────────────────────────────────

/// Derive the registry table key from a raw UEN with the domain tag.
/// AD: domain-tag namespacing so future mobile-number proxies don't collide.
fun derive_uen_hash(uen: &vector<u8>): vector<u8> {
    let mut buf = b"PAYNOW_UEN_V1";
    vector::append(&mut buf, *uen);
    hash::blake2b256(&buf)
}

// ─── Entry: register_merchant ───────────────────────────────────────────

/// Merchant claims a UEN by presenting an issuer-signed attestation.
/// The on-chain canonical message is BCS-encoded `ClaimMessage`, hashed
/// with blake2b256 before ed25519 verification.
public fun register_merchant(
    registry: &mut MerchantRegistry,
    uen_bytes: vector<u8>,
    nonce: vector<u8>,
    attestation: vector<u8>,
    expires_at_ms: u64,
    metadata_uri: Option<String>,
    evidence_hash: vector<u8>,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    // AD21: refuse claims until the issuer pubkey has been set.
    assert!(!vector::is_empty(&registry.issuer_pubkey), E_REGISTRY_NOT_INITIALIZED);

    let now = clock::timestamp_ms(clock);
    // AD22: reject expired attestations.
    assert!(now <= expires_at_ms, E_ATTESTATION_EXPIRED);

    let uen_hash = derive_uen_hash(&uen_bytes);
    assert!(!table::contains(&registry.entries, uen_hash), E_UEN_ALREADY_CLAIMED);
    assert!(!table::contains(&registry.used_nonces, nonce), E_NONCE_REPLAYED);

    let sender = ctx.sender();

    // AD19 + AD24: BCS-encode the canonical message including chain_id +
    // evidence_hash. The issuer signs over evidence content; on-chain
    // verification proves the attestation was bound to that evidence.
    let msg = ClaimMessage {
        domain_tag: b"QUAY_CLAIM_V1",
        chain_id: registry.chain_id,
        uen: uen_bytes,
        claimer: sender,
        nonce,
        expires_at_ms,
        evidence_hash,
    };
    let msg_bytes = bcs::to_bytes(&msg);
    let msg_hash = hash::blake2b256(&msg_bytes);

    let ok = ed25519::ed25519_verify(&attestation, &registry.issuer_pubkey, &msg_hash);
    assert!(ok, E_INVALID_ATTESTATION);

    table::add(&mut registry.used_nonces, msg.nonce, true);
    table::add(
        &mut registry.entries,
        uen_hash,
        MerchantEntry {
            sui_address: sender,
            claimed_at_ms: now,
            uen_raw: msg.uen,
            metadata_uri,
            evidence_hash: msg.evidence_hash,
        },
    );

    event::emit(MerchantRegistered {
        uen_hash,
        sui_address: sender,
        timestamp_ms: now,
    });
}

// ─── Entry: pay ─────────────────────────────────────────────────────────

/// Generic over `Coin<T>`; transfers the coin to the merchant address
/// indexed by the UEN, and emits a PaymentReceipt event with the SGD-
/// equivalent amount and quote metadata (AD23).
public fun pay<T>(
    registry: &MerchantRegistry,
    uen_bytes: vector<u8>,
    coin: Coin<T>,
    memo: Option<vector<u8>>,
    sgd_minor_units: u64,
    quote_metadata: Option<vector<u8>>,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    let uen_hash = derive_uen_hash(&uen_bytes);
    assert!(table::contains(&registry.entries, uen_hash), E_UEN_NOT_REGISTERED);

    let entry = table::borrow(&registry.entries, uen_hash);
    let amount = coin::value(&coin);
    assert!(amount > 0, E_PAYMENT_BELOW_MIN);

    let payer = ctx.sender();
    let merchant = entry.sui_address;
    let now = clock::timestamp_ms(clock);

    // Deterministic receipt_id for indexing + refund linkage.
    let mut id_msg = uen_hash;
    vector::append(&mut id_msg, bcs::to_bytes(&payer));
    vector::append(&mut id_msg, bcs::to_bytes(&now));
    vector::append(&mut id_msg, bcs::to_bytes(&amount));
    let receipt_id = hash::blake2b256(&id_msg);

    transfer::public_transfer(coin, merchant);

    event::emit(PaymentReceipt {
        receipt_id,
        merchant,
        payer,
        amount,
        token_type: type_name::with_defining_ids<T>(),
        uen_hash,
        timestamp_ms: now,
        memo,
        sgd_minor_units,
        quote_metadata,
    });
}

// ─── Entry: refund ──────────────────────────────────────────────────────

/// Merchant initiates a refund. The refund coin is whatever the merchant
/// chooses to send; the event links the refund to an original receipt_id
/// (delivered to the merchant by their POS / terminal UI).
public fun refund<T>(
    original_receipt_id: vector<u8>,
    payer: address,
    coin: Coin<T>,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    let amount = coin::value(&coin);
    assert!(amount > 0, E_REFUND_AMOUNT_ZERO);

    let merchant = ctx.sender();
    transfer::public_transfer(coin, payer);

    event::emit(RefundIssued {
        original_receipt_id,
        merchant,
        payer,
        amount,
        token_type: type_name::with_defining_ids<T>(),
        timestamp_ms: clock::timestamp_ms(clock),
    });
}

// ─── Entry: update_merchant_address (wallet rotation) ───────────────────

public fun update_merchant_address(
    registry: &mut MerchantRegistry,
    uen_bytes: vector<u8>,
    new_address: address,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    let uen_hash = derive_uen_hash(&uen_bytes);
    assert!(table::contains(&registry.entries, uen_hash), E_UEN_NOT_REGISTERED);

    let entry = table::borrow_mut(&mut registry.entries, uen_hash);
    assert!(entry.sui_address == ctx.sender(), E_NOT_MERCHANT_OWNER);

    let old = entry.sui_address;
    entry.sui_address = new_address;

    event::emit(MerchantAddressUpdated {
        uen_hash,
        old_address: old,
        new_address,
        timestamp_ms: clock::timestamp_ms(clock),
    });
}

/// Update the merchant's metadata blob pointer. Caller must be the
/// current owner of the UEN. Used by `/merchant/wallet` to let merchants
/// change their preferred receive token (or rotate their logo) after
/// onboarding without re-claiming the UEN. The new blob is a v1 Walrus
/// profile JSON the frontend builds; this call just swaps the pointer.
public fun update_merchant_metadata(
    registry: &mut MerchantRegistry,
    uen_bytes: vector<u8>,
    new_metadata_uri: Option<String>,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    let uen_hash = derive_uen_hash(&uen_bytes);
    assert!(table::contains(&registry.entries, uen_hash), E_UEN_NOT_REGISTERED);

    let entry = table::borrow_mut(&mut registry.entries, uen_hash);
    assert!(entry.sui_address == ctx.sender(), E_NOT_MERCHANT_OWNER);

    entry.metadata_uri = new_metadata_uri;

    event::emit(MerchantMetadataUpdated {
        uen_hash,
        new_metadata_uri: entry.metadata_uri,
        timestamp_ms: clock::timestamp_ms(clock),
    });
}

// ─── View helpers (off-chain RPC convenience) ───────────────────────────

public fun is_registered(registry: &MerchantRegistry, uen_bytes: vector<u8>): bool {
    table::contains(&registry.entries, derive_uen_hash(&uen_bytes))
}

public fun merchant_address(registry: &MerchantRegistry, uen_bytes: vector<u8>): address {
    let uen_hash = derive_uen_hash(&uen_bytes);
    assert!(table::contains(&registry.entries, uen_hash), E_UEN_NOT_REGISTERED);
    table::borrow(&registry.entries, uen_hash).sui_address
}

public fun chain_id(registry: &MerchantRegistry): u8 {
    registry.chain_id
}

public fun issuer_pubkey(registry: &MerchantRegistry): vector<u8> {
    registry.issuer_pubkey
}

// ─── Test-only helpers ──────────────────────────────────────────────────

#[test_only]
public fun init_for_testing(ctx: &mut TxContext) {
    init(ctx)
}

#[test_only]
public fun canonical_claim_bytes(
    chain_id: u8,
    uen: vector<u8>,
    claimer: address,
    nonce: vector<u8>,
    expires_at_ms: u64,
    evidence_hash: vector<u8>,
): vector<u8> {
    bcs::to_bytes(
        &ClaimMessage {
            domain_tag: b"QUAY_CLAIM_V1",
            chain_id,
            uen,
            claimer,
            nonce,
            expires_at_ms,
            evidence_hash,
        },
    )
}

#[test_only]
public fun canonical_claim_hash(
    chain_id: u8,
    uen: vector<u8>,
    claimer: address,
    nonce: vector<u8>,
    expires_at_ms: u64,
    evidence_hash: vector<u8>,
): vector<u8> {
    hash::blake2b256(&canonical_claim_bytes(
        chain_id, uen, claimer, nonce, expires_at_ms, evidence_hash,
    ))
}

#[test_only]
public fun derive_uen_hash_for_testing(uen: vector<u8>): vector<u8> {
    derive_uen_hash(&uen)
}

/// Test-only registration helper that bypasses ed25519 verification.
/// Use only to set up state for downstream-flow tests (pay, refund,
/// update_address). The ed25519 verification path itself is exercised
/// by tests that exercise `register_merchant` directly.
#[test_only]
public fun register_for_testing(
    registry: &mut MerchantRegistry,
    uen_bytes: vector<u8>,
    merchant: address,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    let uen_hash = derive_uen_hash(&uen_bytes);
    let now = clock::timestamp_ms(clock);
    table::add(
        &mut registry.entries,
        uen_hash,
        MerchantEntry {
            sui_address: merchant,
            claimed_at_ms: now,
            uen_raw: uen_bytes,
            metadata_uri: option::none(),
            evidence_hash: vector::empty<u8>(),
        },
    );
    let _ = ctx;
}
