---
'@e2b/python-sdk': minor
'e2b': minor
---

Add native x402 payment support to sandboxes.

`Sandbox.create({ payments: { privateKey, network, maxSpend } })` enables AI agents to autonomously pay for HTTP 402-gated APIs using USDC on Base. The injected wallet credentials and pre-built `e2b-payments-{js,py}` sandbox templates handle the EIP-3009 signing and retry transparently — no agent code changes needed.

A new `sandbox.payments` namespace provides:
- `getBalance()` — on-chain USDC balance for the wallet
- `getHistory()` — log of payments made from this sandbox
- `setSpendingLimit(usd)` — update the spending cap without restarting
