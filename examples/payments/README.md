# E2B Sandbox x402 Payments — Demo

AI agent that autonomously pays for paid APIs using USDC on Base Sepolia,
running inside an E2B sandbox.

## How it works

1. You create a sandbox with a `payments` config (wallet key + spending cap).
2. The SDK injects wallet credentials as env vars into the sandbox.
3. Inside the sandbox, an HTTP interceptor patches `httpx`/`fetch`.
4. When the agent hits a paid API, it gets a 402 → the interceptor signs
   an EIP-3009 USDC transfer and retries — automatically.
5. Each payment is logged to `/tmp/.e2b-payments.jsonl` inside the sandbox.
6. From outside, `sandbox.payments.getHistory()` shows what was spent.

## Prerequisites

- E2B account and API key (`E2B_API_KEY`)
- Base Sepolia wallet with test USDC (free at <https://faucet.circle.com>)
- A live Base Sepolia x402 endpoint (`X402_API_ENDPOINT`)

## Run the Python demo

```bash
cd python-agent
pip install e2b httpx
export WALLET_PRIVATE_KEY=0x...
export X402_API_ENDPOINT=https://...
export E2B_API_KEY=...
python run.py
```

## Run the JS demo

```bash
cd js-agent
npm install e2b
export WALLET_PRIVATE_KEY=0x...
export X402_API_ENDPOINT=https://...
export E2B_API_KEY=...
node run.mjs
```

## SDK API at a glance

```python
from e2b import Sandbox, PaymentConfig

sandbox = Sandbox.create(
    payments=PaymentConfig(
        private_key=os.environ["WALLET_PRIVATE_KEY"],
        network="base-sepolia",   # or "base" for mainnet
        max_spend=1.00,           # USD cap, optional
    )
)

# Observability
balance = sandbox.payments.get_balance()
history = sandbox.payments.get_history()
sandbox.payments.set_spending_limit(0.50)
```

```typescript
import { Sandbox } from 'e2b'

const sandbox = await Sandbox.create({
  payments: {
    privateKey: process.env.WALLET_PRIVATE_KEY!,
    network: 'base-sepolia',
    maxSpend: 1.0,
  }
})

const balance = await sandbox.payments!.getBalance()
const history = await sandbox.payments!.getHistory()
await sandbox.payments!.setSpendingLimit(0.5)
```

## Find x402 services

<https://mpp.dev/services> lists 100+ live endpoints.
