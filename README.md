# suiqr

SGQR-compatible Sui payments. Scan any Singapore SGQR sticker, pay any Sui token, settle as USDC to a merchant onboarded via Gmail (zkLogin).

> Sui Overflow hackathon submission. Architecture, demo, deploy walkthrough, and "Why not just off-ramp?" demo-Q&A defense land on Day 12.5.

## Build status

- [x] Plan APPROVED — see `/Users/ryan/.claude/plans/claude-code-handoff-nifty-locket.md`
- [x] Day 0 testnet validation (Pyth USD/SGD live; zkLogin + sponsored-tx OK; Cetus IDs deferred to Day 5)
- [x] Day 1 — Move module + 18 unit tests passing
- [x] Day 2 — Live on Sui testnet, end-to-end pay flow verified
- [ ] Days 3-14 — see `TODOS.md`

## Testnet deployment

```
Network:          testnet (chain_id = 4c78adac)
Package:          0x46398f18d42864b8325c0089bd0ae6ba439c85d02510412738ce273c53ce167e
MerchantRegistry: 0x00148a23a4e120142965ed011370b39a42e858174aec98d5fac079a834c1e5e1
AdminCap owner:   0xa91644aa47914b16b73258c1de984e3296ef15e40a838ffd3b8fa533b27def2f
Issuer pubkey:    0x5d44735e96af7d30d245936458efc03f5fdc4ba042046848afc4ad9dd8d115c8
```

Demo flow on-chain:

- Publish: [41WRCow…E3p](https://suiscan.xyz/testnet/tx/41WRCow4ZhXGzHA8vLt7v6vZEubXBgk4kBcEWbrDbE3p)
- Set initial issuer pubkey: [CFEfJoE…R1U](https://suiscan.xyz/testnet/tx/CFEfJoEBrb87N3M7u8fq46RDA7SU5JCPqTKr3bwGUR1U)
- Register merchant1 (UEN `202412345Z`): [DQ8ayrS…2hXK](https://suiscan.xyz/testnet/tx/DQ8ayrSsHyLxr1U8ekNaBz434Cw8DjgmBV1J4fkT2hXK)
- Pay merchant1 $1.50 SGD-equivalent (1.5M MIST): [B6YpJM7…sNae](https://suiscan.xyz/testnet/tx/B6YpJM7CcKPRXVL9kbTavYioY6VhuDemwcoYuikVsNae)

Full deploy config: [`scripts/deploy-testnet.json`](./scripts/deploy-testnet.json).

## Quickstart

Coming on Day 12.5. For now, read [`TODOS.md`](./TODOS.md).
