# Day 0 testnet validation results (AD1)

Generated 2026-05-12T13:45:13.381Z against Sui testnet.

Summary: 4 PASS · 1 FALLBACK · 0 FAIL

| # | Check | Status | Detail |
|---|-------|--------|--------|
| 1 | Sui testnet RPC reachable | PASS | chain_id=4c78adac epoch=1097 |
| 2 | Pyth SGD pricing (Hermes) | PASS | FX.USD/SGD live (id 396a969a…); invert at compute time for SGD→USD. SUI/USD found, USDC/USD found. |
| 3 | zkLogin SDK (@mysten/zklogin) | PASS | Ephemeral keypair generated; randomness ok; nonce produced (27 chars) |
| 4 | Sponsored-tx PTB construction | PASS | Sponsored PTB built; sender != gasOwner; tx bytes 199 |
| 5 | Pyth + Cetus testnet deployments + compose | FALLBACK | Could not verify both packages via hardcoded candidate IDs (pyth_state=true, cetus_global_config=false). Look up live IDs from docs: Pyth https://docs.pyth.network/price-feeds/contract-addresses/sui, Cetus https://cetus-1.gitbook.io/cetus-developer-docs. Re-check on Day 4 (Pyth) / Day 5 (Cetus). Compose is guaranteed by Sui runtime regardless. |

## Evidence

### Sui testnet RPC reachable
```json
{
  "chain_id": "4c78adac",
  "epoch": "1097",
  "protocol_version": "123"
}
```

### Pyth SGD pricing (Hermes)
```json
{
  "sgd_feed_id": "396a969a9c1480fa15ed50bc59149e2c0075a72fe8f458ed941ddec48bdb4918",
  "sgd_symbol": "FX.USD/SGD",
  "sgd_base": "USD",
  "sgd_quote": "SGD",
  "invert_at_compute": true,
  "sui_usd_id": "23d7315113f5b1d3ba7a83604c44b94d79f4fd69af77f804fc7f920a6dc65744",
  "usdc_usd_id": "eaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a"
}
```

### zkLogin SDK (@mysten/zklogin)
```json
{
  "nonce_len": 27,
  "ephemeral_address": "0x95fe010466df43da2fa6d592cef246d6e4f82f431d02cbc19b42c87078e771a8"
}
```

### Sponsored-tx PTB construction
```json
{
  "sender": "0x31be8b1ed57b79f08545dad91795b804030decaf6b2b00d9277de4fa5b4b36bd",
  "gas_owner": "0xa52a5786e4f78d24bfbfba9f56035097d10875ff5b83d1750c1ac87b87d1f88d",
  "tx_bytes_len": 199
}
```

### Pyth + Cetus testnet deployments + compose
```json
{
  "pyth_state": {
    "found": true,
    "type": "0xabf837e98c26087cba0883c0a7a28326b1fa3c5e1e2c5abdb486f9e8f594c837::state::State"
  },
  "wormhole_state": {
    "found": true,
    "type": "0xcc029e2810f17f9f43f52262f40026a71fbdca40ed3803ad2884994361910b7e::state::State"
  },
  "cetus_global_config": {
    "found": false
  }
}
```

## Interpretation

- `PASS` = hypothesis validated; proceed as planned.
- `FALLBACK` = primary path uncertain; apply the pre-baked plan-B from the build plan, re-check on the integration day.
- `FAIL` = load-bearing hypothesis broken; halt and re-plan.
