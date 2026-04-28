# Sandbox Payments — x402 Native Integration Design

**Date:** 2026-04-28
**Protocol:** x402 (Coinbase)
**Scope:** JS SDK + Python SDK (sync + async), two sandbox templates, unit + integration tests

---

## Problem

AI agents running in E2B sandboxes cannot autonomously pay for external services. When an agent hits a paid API it receives a `402 Payment Required` response and stalls — there is no built-in mechanism to handle the challenge-response payment flow. Developers currently work around this by pre-provisioning API keys and injecting them manually, which does not scale for agents that discover and consume services dynamically.

The x402 protocol (Coinbase, 2025) defines a standard HTTP 402 challenge-response flow that enables machine-to-machine payments using USDC on Base L2. Over 100 services already support x402 with $600M+ annualized volume. This design integrates x402 natively into the E2B SDK so agents can pay autonomously without any changes to agent code.

---

## API Surface

### Sandbox creation

**JS SDK:**
```typescript
const sandbox = await Sandbox.create({
  template: "e2b/payments-js",
  payments: {
    privateKey: process.env.WALLET_PRIVATE_KEY,  // 0x-prefixed 32-byte hex
    network: "base",                              // "base" | "base-sepolia" (default)
    maxSpend: 5.00,                               // USD spending cap, optional
  }
})
```

**Python SDK:**
```python
from e2b import Sandbox, PaymentConfig

sandbox = Sandbox.create(
    template="e2b/payments-py",
    payments=PaymentConfig(
        private_key=os.environ["WALLET_PRIVATE_KEY"],
        network="base",           # default: "base-sepolia"
        max_spend=5.00,           # optional
    )
)
```

### Payments namespace on sandbox instance

**JS SDK:**
```typescript
// Read on-chain USDC balance (does not require private key)
const balance = await sandbox.payments.getBalance()
// → { usdc: 4.73, address: "0xabc..." }

// Read payment history from inside the sandbox
const history = await sandbox.payments.getHistory()
// → [{ timestamp, url, amountUsd, txHash, status }, ...]

// Update spending cap without restarting the sandbox
await sandbox.payments.setSpendingLimit(2.00)
```

**Python SDK (sync + async):**
```python
balance = sandbox.payments.get_balance()
history = sandbox.payments.get_history()
sandbox.payments.set_spending_limit(2.00)
```

### PaymentEvent type

```typescript
interface PaymentEvent {
  timestamp: string    // ISO 8601
  url: string          // endpoint that triggered the payment
  amountUsd: number
  txHash: string       // on-chain transaction hash on Base
  status: "success" | "failed"
}
```

**Python equivalent:**
```python
@dataclass
class PaymentEvent:
    timestamp: str
    url: str
    amount_usd: float
    tx_hash: str
    status: Literal["success", "failed"]
```

New types exported from `packages/js-sdk/src/index.ts`: `PaymentConfig`, `PaymentEvent`, `SandboxPayments`.

---

## Architecture

### Injection flow (Sandbox.create)

1. SDK validates `payments` config: private key is 0x-prefixed 32-byte hex, network is a known value, maxSpend is non-negative if provided.
2. SDK merges payment env vars into the sandbox `envs` before the API request:
   ```
   E2B_PAYMENT_PRIVATE_KEY=0x...
   E2B_PAYMENT_NETWORK=base-sepolia
   E2B_PAYMENT_MAX_SPEND=5.00        (omitted if not set)
   ```
3. Sandbox starts. The template's init script writes `E2B_PAYMENT_MAX_SPEND` to `/tmp/.e2b-payment-limit` and activates the HTTP interceptor.

### Inside the sandbox

The x402 interceptor wraps the default HTTP client at import time:

- **Python:** monkey-patches `httpx.Client` and `httpx.AsyncClient`
- **Node.js:** wraps the global `fetch`

When agent code makes any outbound HTTP request:
1. If the response is not `402`, pass through unchanged — zero overhead.
2. If `402`, decode the `PAYMENT-REQUIRED` header, check current spend against `/tmp/.e2b-payment-limit`.
3. If within budget: sign a USDC `TransferWithAuthorization` using `E2B_PAYMENT_PRIVATE_KEY`, retry with `X-PAYMENT` header.
4. Append a JSON line to `/tmp/.e2b-payments.jsonl` recording the outcome.
5. If over budget: raise `SpendingLimitExceeded` — the agent sees a clear error.

Agent code requires zero changes. An agent that does `httpx.get("https://paid-api.com/data")` works identically with or without the interceptor present.

### Observability flow (SDK ↔ sandbox)

```
sandbox.payments.getHistory()
  → sandbox.filesystem.read("/tmp/.e2b-payments.jsonl")
  → parse JSONL lines → PaymentEvent[]

sandbox.payments.getBalance()
  → Base RPC call from SDK process (no sandbox involvement)
  → USDC contract balanceOf(wallet_address)
  → { usdc: float, address: str }

sandbox.payments.setSpendingLimit(n)
  → sandbox.filesystem.write("/tmp/.e2b-payment-limit", str(n))
  → interceptor re-reads file before each payment
```

`getBalance` uses only the public wallet address — the private key never leaves the sandbox. `getHistory` and `setSpendingLimit` use the existing sandbox filesystem API with no new protocol.

---

## Template Strategy

Two Dockerfiles, one per language:

| Template ID | Base image | Added packages |
|---|---|---|
| `e2b/payments-py` | `e2b/python` | `x402` Python client, `httpx`, `e2b-payments` interceptor |
| `e2b/payments-js` | `e2b/node` | `x402` npm package, `e2b-payments` interceptor |

**Init script** (runs on sandbox boot if `E2B_PAYMENT_PRIVATE_KEY` is set):
```bash
#!/bin/bash
[ -n "$E2B_PAYMENT_PRIVATE_KEY" ] || exit 0
echo "${E2B_PAYMENT_MAX_SPEND:-}" > /tmp/.e2b-payment-limit
touch /tmp/.e2b-payments.jsonl
```

**Backwards compatibility:** Templates function as normal Python/Node sandboxes when `E2B_PAYMENT_PRIVATE_KEY` is absent. The interceptor is a no-op without credentials.

The Python interceptor activates via a single import:
```python
import e2b_payments  # httpx is now payment-aware — that's it
```

---

## Testing Strategy

### Unit tests (no live sandbox, no chain)

Cover config validation and env var construction:

- Reject invalid private key formats
- Default network to `base-sepolia`
- Reject negative `maxSpend`
- Correctly merge payment env vars into sandbox `envs`
- Parse `PaymentEvent` from JSONL correctly
- `SpendingLimitExceeded` raised when cumulative spend would exceed cap

Both JS (Vitest) and Python (pytest) unit tests live in the existing test structure.

### Integration tests (live sandbox, Base Sepolia testnet)

Run against a real sandbox using a funded testnet wallet. Fit within E2B's existing 60s integration test timeout.

```typescript
// JS integration test
test("agent autonomously pays for x402 API call", { timeout: 60_000 }, async () => {
  const sandbox = await Sandbox.create({
    template: "e2b/payments-js",
    payments: { privateKey: process.env.TEST_WALLET_KEY, network: "base-sepolia" }
  })
  await sandbox.commands.run("node agent.js")
  const history = await sandbox.payments.getHistory()
  expect(history).toHaveLength(1)
  expect(history[0].status).toBe("success")
})
```

```python
# Python integration test
def test_spending_limit_blocks_overspend():
    sandbox = Sandbox.create(
        template="e2b/payments-py",
        payments=PaymentConfig(private_key=TEST_KEY, network="base-sepolia", max_spend=0.001)
    )
    result = sandbox.commands.run("python agent.py")
    assert "SpendingLimitExceeded" in result.stderr
```

**Test credentials:** `TEST_WALLET_KEY` in `.env.local` — same pattern as `E2B_API_KEY`. Funded with free Base Sepolia testnet USDC from Coinbase faucet.

---

## Demo Repo Structure

```
e2b-payments-demo/
├── README.md                    # job-application-quality writeup
├── templates/
│   ├── payments-py/Dockerfile
│   └── payments-js/Dockerfile
├── examples/
│   ├── search-agent/            # agent that pays for a live x402 search API
│   └── multi-service-agent/     # agent that chains multiple paid API calls
├── sdk-proposal/
│   ├── js/                      # fork diff showing JS SDK changes
│   └── python/                  # fork diff showing Python SDK changes
└── docs/
    └── architecture.png         # flow diagram
```

---

## Out of Scope

- MPP (Tempo/Stripe) support — separate feature, separate PR
- Fiat/card payment fallback
- Server-side x402 (E2B sandboxes acting as paid API providers)
- Wallet provisioning / key management (user supplies their own key)
- Multi-wallet or per-sandbox wallet generation
