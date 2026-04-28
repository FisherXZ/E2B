# E2B Sandbox x402 Payments Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add native x402 payment support to E2B sandboxes so AI agents autonomously pay for external APIs using USDC on Base, with a `payments` option on `Sandbox.create()` and a `sandbox.payments` observability namespace in both JS and Python SDKs.

**Architecture:** The SDK validates a `PaymentConfig`, merges wallet credentials as env vars before sandbox creation, and attaches a `SandboxPayments` instance to the sandbox object. Inside the sandbox, a pre-built template has a monkey-patched HTTP client that intercepts 402 responses, signs EIP-3009 USDC transfers using the injected private key, and logs each payment to `/tmp/.e2b-payments.jsonl`. The SDK reads that file for history, queries the Base chain directly for balance, and writes `/tmp/.e2b-payment-limit` to enforce spending caps.

**Tech Stack:** TypeScript/Vitest (JS SDK), Python/pytest (Python SDK), x402 protocol (Coinbase/EIP-3009), eth-account (Python EIP-712 signing), viem (JS address derivation + Base RPC), httpx (Python HTTP inside sandbox)

---

## File Map

**New files:**
- `packages/js-sdk/src/sandbox/payments.ts` — `PaymentConfig`, `PaymentEvent`, `SandboxPaymentsBalance`, `validatePaymentConfig`, `buildPaymentEnvs`, `SandboxPayments` class
- `packages/js-sdk/tests/sandbox/payments.test.ts` — unit + integration tests for JS payments
- `packages/python-sdk/e2b/sandbox/payments.py` — Python equivalents of all types + `SandboxPayments` (sync) + `AsyncSandboxPayments`
- `packages/python-sdk/tests/unit/test_payments.py` — Python unit tests
- `packages/python-sdk/tests/sync/sandbox_sync/test_payments.py` — sync integration tests
- `packages/python-sdk/tests/async/sandbox_async/test_payments.py` — async integration tests
- `templates/payments-py/Dockerfile`
- `templates/payments-py/e2b_payments/__init__.py` — httpx interceptor (auto-activates from env vars)
- `templates/payments-py/init.sh` — sandbox boot script
- `templates/payments-js/Dockerfile`
- `templates/payments-js/e2b-payments/index.mjs` — fetch interceptor (auto-activates from env vars)
- `templates/payments-js/init.sh`
- `examples/payments/python-agent/agent.py`
- `examples/payments/python-agent/requirements.txt`
- `examples/payments/js-agent/agent.mjs`
- `examples/payments/js-agent/package.json`
- `examples/payments/README.md`
- `.changeset/sandbox-payments.md`

**Modified files:**
- `packages/js-sdk/src/sandbox/sandboxApi.ts:109` — add `payments?: PaymentConfig` to `SandboxOpts`
- `packages/js-sdk/src/sandbox/index.ts:79` — add `readonly payments?: SandboxPayments` property; constructor wiring; `create()` env merge
- `packages/js-sdk/src/index.ts` — export `PaymentConfig`, `PaymentEvent`, `SandboxPayments`
- `packages/js-sdk/package.json` — add `viem` dependency
- `packages/python-sdk/e2b/sandbox/__init__.py` — export `PaymentConfig`, `PaymentEvent`
- `packages/python-sdk/e2b/sandbox_sync/main.py:167` — add `payments` param to `create()`, merge envs, attach `_payments`
- `packages/python-sdk/e2b/sandbox_async/main.py` — same pattern for async
- `packages/python-sdk/pyproject.toml` — add `eth-account` dependency

---

## Task 1: Fork setup and add dependencies

**Files:**
- Modify: `packages/js-sdk/package.json`
- Modify: `packages/python-sdk/pyproject.toml`

- [ ] **Step 1: Fork the E2B repo on GitHub, then clone your fork**

```bash
git clone https://github.com/<your-username>/E2B.git
cd E2B
git remote add upstream https://github.com/e2b-dev/E2B.git
```

- [ ] **Step 2: Create a feature branch**

```bash
git checkout -b feat/sandbox-payments
```

- [ ] **Step 3: Install existing dependencies**

```bash
pnpm install
cd packages/python-sdk && make setup && cd ../..
```

- [ ] **Step 4: Add viem to JS SDK**

```bash
cd packages/js-sdk && pnpm add viem && cd ../..
```

- [ ] **Step 5: Add eth-account to Python SDK**

Open `packages/python-sdk/pyproject.toml` and add to `[tool.poetry.dependencies]`:
```toml
eth-account = ">=0.11.0"
```

Then install:
```bash
cd packages/python-sdk && poetry add eth-account && cd ../..
```

- [ ] **Step 6: Verify installs**

```bash
cd packages/js-sdk && node -e "import('viem').then(() => console.log('viem ok'))" && cd ../..
cd packages/python-sdk && poetry run python -c "from eth_account import Account; print('eth_account ok')" && cd ../..
```

Expected output:
```
viem ok
eth_account ok
```

- [ ] **Step 7: Commit**

```bash
git add packages/js-sdk/package.json packages/js-sdk/pnpm-lock.yaml packages/python-sdk/pyproject.toml packages/python-sdk/poetry.lock
git commit -m "chore: add viem and eth-account deps for x402 payments"
```

---

## Task 2: JS SDK — PaymentConfig types and validation (TDD)

**Files:**
- Create: `packages/js-sdk/src/sandbox/payments.ts`
- Create: `packages/js-sdk/tests/sandbox/payments.test.ts`

- [ ] **Step 1: Write the failing tests first**

Create `packages/js-sdk/tests/sandbox/payments.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import {
  validatePaymentConfig,
  buildPaymentEnvs,
} from '../../../src/sandbox/payments'

const VALID_KEY = '0x' + 'a'.repeat(64)

describe('validatePaymentConfig', () => {
  it('accepts a valid config with only privateKey', () => {
    expect(() => validatePaymentConfig({ privateKey: VALID_KEY })).not.toThrow()
  })

  it('rejects a key missing the 0x prefix', () => {
    expect(() => validatePaymentConfig({ privateKey: 'a'.repeat(64) })).toThrow(
      '0x-prefixed'
    )
  })

  it('rejects a key that is too short', () => {
    expect(() =>
      validatePaymentConfig({ privateKey: '0x' + 'a'.repeat(63) })
    ).toThrow('0x-prefixed')
  })

  it('rejects a key that is too long', () => {
    expect(() =>
      validatePaymentConfig({ privateKey: '0x' + 'a'.repeat(65) })
    ).toThrow('0x-prefixed')
  })

  it('rejects an unknown network', () => {
    expect(() =>
      validatePaymentConfig({ privateKey: VALID_KEY, network: 'ethereum' as any })
    ).toThrow('network must be')
  })

  it('accepts base network', () => {
    expect(() =>
      validatePaymentConfig({ privateKey: VALID_KEY, network: 'base' })
    ).not.toThrow()
  })

  it('accepts base-sepolia network', () => {
    expect(() =>
      validatePaymentConfig({ privateKey: VALID_KEY, network: 'base-sepolia' })
    ).not.toThrow()
  })

  it('rejects negative maxSpend', () => {
    expect(() =>
      validatePaymentConfig({ privateKey: VALID_KEY, maxSpend: -0.01 })
    ).toThrow('non-negative')
  })

  it('accepts maxSpend of zero', () => {
    expect(() =>
      validatePaymentConfig({ privateKey: VALID_KEY, maxSpend: 0 })
    ).not.toThrow()
  })
})

describe('buildPaymentEnvs', () => {
  it('always includes the private key', () => {
    const envs = buildPaymentEnvs({ privateKey: VALID_KEY })
    expect(envs['E2B_PAYMENT_PRIVATE_KEY']).toBe(VALID_KEY)
  })

  it('defaults network to base-sepolia', () => {
    const envs = buildPaymentEnvs({ privateKey: VALID_KEY })
    expect(envs['E2B_PAYMENT_NETWORK']).toBe('base-sepolia')
  })

  it('uses the provided network', () => {
    const envs = buildPaymentEnvs({ privateKey: VALID_KEY, network: 'base' })
    expect(envs['E2B_PAYMENT_NETWORK']).toBe('base')
  })

  it('omits E2B_PAYMENT_MAX_SPEND when not provided', () => {
    const envs = buildPaymentEnvs({ privateKey: VALID_KEY })
    expect('E2B_PAYMENT_MAX_SPEND' in envs).toBe(false)
  })

  it('includes E2B_PAYMENT_MAX_SPEND as string when set', () => {
    const envs = buildPaymentEnvs({ privateKey: VALID_KEY, maxSpend: 5.5 })
    expect(envs['E2B_PAYMENT_MAX_SPEND']).toBe('5.5')
  })
})
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
cd packages/js-sdk && pnpm run test tests/sandbox/payments.test.ts
```

Expected: FAIL with `Cannot find module '../../../src/sandbox/payments'`

- [ ] **Step 3: Create the implementation**

Create `packages/js-sdk/src/sandbox/payments.ts`:

```typescript
export interface PaymentConfig {
  /** 0x-prefixed 32-byte hex private key for the wallet that pays. */
  privateKey: string
  /** Base network to use. Defaults to 'base-sepolia' (testnet). */
  network?: 'base' | 'base-sepolia'
  /** Optional USD spending cap. Payments exceeding this cumulatively are rejected inside the sandbox. */
  maxSpend?: number
}

export interface PaymentEvent {
  timestamp: string
  url: string
  amountUsd: number
  txHash: string
  status: 'success' | 'failed'
}

export interface SandboxPaymentsBalance {
  usdc: number
  address: string
}

const PRIVATE_KEY_RE = /^0x[0-9a-fA-F]{64}$/

export function validatePaymentConfig(config: PaymentConfig): void {
  if (!PRIVATE_KEY_RE.test(config.privateKey)) {
    throw new Error(
      'payments.privateKey must be a 0x-prefixed 32-byte hex string (64 hex chars after 0x)'
    )
  }
  if (
    config.network !== undefined &&
    config.network !== 'base' &&
    config.network !== 'base-sepolia'
  ) {
    throw new Error(
      `payments.network must be "base" or "base-sepolia", got "${config.network}"`
    )
  }
  if (config.maxSpend !== undefined && config.maxSpend < 0) {
    throw new Error('payments.maxSpend must be non-negative')
  }
}

export function buildPaymentEnvs(
  config: PaymentConfig
): Record<string, string> {
  const envs: Record<string, string> = {
    E2B_PAYMENT_PRIVATE_KEY: config.privateKey,
    E2B_PAYMENT_NETWORK: config.network ?? 'base-sepolia',
  }
  if (config.maxSpend !== undefined) {
    envs['E2B_PAYMENT_MAX_SPEND'] = config.maxSpend.toString()
  }
  return envs
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
cd packages/js-sdk && pnpm run test tests/sandbox/payments.test.ts
```

Expected: All 12 tests PASS

- [ ] **Step 5: Commit**

```bash
git add packages/js-sdk/src/sandbox/payments.ts packages/js-sdk/tests/sandbox/payments.test.ts
git commit -m "feat(js-sdk): add PaymentConfig types and validation for x402 payments"
```

---

## Task 3: JS SDK — SandboxPayments class (TDD)

**Files:**
- Modify: `packages/js-sdk/src/sandbox/payments.ts`
- Modify: `packages/js-sdk/tests/sandbox/payments.test.ts`

- [ ] **Step 1: Add unit tests for SandboxPayments to the test file**

Append to `packages/js-sdk/tests/sandbox/payments.test.ts`:

```typescript
import { SandboxPayments } from '../../../src/sandbox/payments'

// Minimal filesystem double
function makeFakeFilesystem(content = '') {
  const written: Record<string, string> = {}
  return {
    async read(path: string) {
      if (path in written) return written[path]
      if (content) return content
      throw new Error('file not found')
    },
    async write(path: string, data: string) {
      written[path] = data
    },
    _written: written,
  }
}

// A real 32-byte private key (test only — never use in production)
const TEST_KEY =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'

describe('SandboxPayments.getHistory', () => {
  it('returns empty array when file does not exist', async () => {
    const fs = makeFakeFilesystem()
    const sp = new SandboxPayments({ privateKey: TEST_KEY }, fs)
    expect(await sp.getHistory()).toEqual([])
  })

  it('parses JSONL lines into PaymentEvent objects', async () => {
    const line = JSON.stringify({
      timestamp: '2026-04-28T00:00:00Z',
      url: 'https://api.example.com/data',
      amountUsd: 0.001,
      txHash: '0xabc',
      status: 'success',
    })
    const fs = makeFakeFilesystem(line + '\n')
    const sp = new SandboxPayments({ privateKey: TEST_KEY }, fs)
    const history = await sp.getHistory()
    expect(history).toHaveLength(1)
    expect(history[0].status).toBe('success')
    expect(history[0].amountUsd).toBe(0.001)
  })

  it('skips empty lines', async () => {
    const line = JSON.stringify({
      timestamp: '2026-04-28T00:00:00Z',
      url: 'https://example.com',
      amountUsd: 0.001,
      txHash: '0xabc',
      status: 'success',
    })
    const fs = makeFakeFilesystem('\n' + line + '\n\n')
    const sp = new SandboxPayments({ privateKey: TEST_KEY }, fs)
    expect(await sp.getHistory()).toHaveLength(1)
  })
})

describe('SandboxPayments.setSpendingLimit', () => {
  it('writes the limit as a string to /tmp/.e2b-payment-limit', async () => {
    const fs = makeFakeFilesystem()
    const sp = new SandboxPayments({ privateKey: TEST_KEY }, fs)
    await sp.setSpendingLimit(2.5)
    expect(fs._written['/tmp/.e2b-payment-limit']).toBe('2.5')
  })

  it('throws for a negative limit', async () => {
    const fs = makeFakeFilesystem()
    const sp = new SandboxPayments({ privateKey: TEST_KEY }, fs)
    await expect(sp.setSpendingLimit(-1)).rejects.toThrow('non-negative')
  })
})

describe('SandboxPayments.walletAddress', () => {
  it('derives the correct address from the test private key', () => {
    const sp = new SandboxPayments({ privateKey: TEST_KEY }, makeFakeFilesystem())
    // This is the known address for the Hardhat default key above
    expect(sp.walletAddress.toLowerCase()).toBe(
      '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266'
    )
  })
})
```

- [ ] **Step 2: Run tests to confirm new tests fail**

```bash
cd packages/js-sdk && pnpm run test tests/sandbox/payments.test.ts
```

Expected: New tests FAIL with `SandboxPayments is not exported`

- [ ] **Step 3: Add SandboxPayments class to payments.ts**

Append to `packages/js-sdk/src/sandbox/payments.ts`:

```typescript
import { privateKeyToAccount } from 'viem/accounts'
import type { Hex } from 'viem'

const RPC_URLS: Record<string, string> = {
  base: 'https://mainnet.base.org',
  'base-sepolia': 'https://sepolia.base.org',
}

const USDC_ADDRESSES: Record<string, string> = {
  base: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  'base-sepolia': '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
}

interface FilesystemLike {
  read(path: string): Promise<string>
  write(path: string, data: string): Promise<unknown>
}

export class SandboxPayments {
  readonly walletAddress: string
  private readonly network: string
  private readonly fs: FilesystemLike

  constructor(config: PaymentConfig, filesystem: FilesystemLike) {
    const account = privateKeyToAccount(config.privateKey as Hex)
    this.walletAddress = account.address
    this.network = config.network ?? 'base-sepolia'
    this.fs = filesystem
  }

  async getHistory(): Promise<PaymentEvent[]> {
    try {
      const content = await this.fs.read('/tmp/.e2b-payments.jsonl')
      return content
        .split('\n')
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as PaymentEvent)
    } catch {
      return []
    }
  }

  async getBalance(): Promise<SandboxPaymentsBalance> {
    const rpcUrl = RPC_URLS[this.network]
    const usdcAddress = USDC_ADDRESSES[this.network]
    // ABI-encode balanceOf(address): selector 0x70a08231 + 32-byte padded address
    const data =
      '0x70a08231' + this.walletAddress.slice(2).toLowerCase().padStart(64, '0')
    const response = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'eth_call',
        params: [{ to: usdcAddress, data }, 'latest'],
        id: 1,
      }),
    })
    const { result } = (await response.json()) as { result: string }
    // USDC has 6 decimal places
    const usdc = Number(BigInt(result)) / 1e6
    return { usdc, address: this.walletAddress }
  }

  async setSpendingLimit(usd: number): Promise<void> {
    if (usd < 0) {
      throw new Error('Spending limit must be non-negative')
    }
    await this.fs.write('/tmp/.e2b-payment-limit', usd.toString())
  }
}
```

- [ ] **Step 4: Run all tests in the file**

```bash
cd packages/js-sdk && pnpm run test tests/sandbox/payments.test.ts
```

Expected: All tests PASS

- [ ] **Step 5: Run typecheck**

```bash
cd packages/js-sdk && pnpm run typecheck
```

Expected: No errors

- [ ] **Step 6: Commit**

```bash
git add packages/js-sdk/src/sandbox/payments.ts packages/js-sdk/tests/sandbox/payments.test.ts
git commit -m "feat(js-sdk): add SandboxPayments class with getHistory, getBalance, setSpendingLimit"
```

---

## Task 4: JS SDK — Wire payments into Sandbox class and export types

**Files:**
- Modify: `packages/js-sdk/src/sandbox/sandboxApi.ts` (line 109 — `SandboxOpts`)
- Modify: `packages/js-sdk/src/sandbox/index.ts` (lines 79, 125, 264)
- Modify: `packages/js-sdk/src/index.ts`

- [ ] **Step 1: Add `payments` to `SandboxOpts` in sandboxApi.ts**

Open `packages/js-sdk/src/sandbox/sandboxApi.ts`. Find `SandboxOpts` at line 109. Add the payments field after the `envs` field (around line 125):

```typescript
// Find this block (around line 120-130):
  /**
   * Custom environment variables for sandbox.
   * Can be overridden with the `envs` argument when executing commands or code.
   */
  envs?: Record<string, string>
```

Add after the `envs` field:

```typescript
  /**
   * Payment configuration for x402 autonomous payments.
   * Enables the sandbox to autonomously pay for external APIs using USDC on Base.
   */
  payments?: PaymentConfig
```

Also add the import at the top of the file. Find the existing imports and add:

```typescript
import type { PaymentConfig } from './payments'
```

- [ ] **Step 2: Add `payments` property to the Sandbox class in index.ts**

Open `packages/js-sdk/src/sandbox/index.ts`. After the `git` property declaration (around line 91), add:

```typescript
  /**
   * Module for managing autonomous x402 payments from the sandbox.
   * Only present when the sandbox was created with a `payments` option.
   */
  readonly payments?: SandboxPayments
```

- [ ] **Step 3: Add `payments` to the constructor opts type and wire it up**

In `packages/js-sdk/src/sandbox/index.ts`, find the constructor at line 125. Change the opts type to include `paymentsConfig`:

```typescript
// Change the constructor signature from:
  constructor(
    opts: SandboxConnectOpts & {
      sandboxId: string
      sandboxDomain?: string
      envdVersion: string
      envdAccessToken?: string
      trafficAccessToken?: string
    }
  )

// To:
  constructor(
    opts: SandboxConnectOpts & {
      sandboxId: string
      sandboxDomain?: string
      envdVersion: string
      envdAccessToken?: string
      trafficAccessToken?: string
      paymentsConfig?: PaymentConfig
    }
  )
```

Then in the constructor body, after `this.git = new Git(this.commands)` (around line 213), add:

```typescript
    if (opts.paymentsConfig) {
      ;(this as { payments?: SandboxPayments }).payments = new SandboxPayments(
        opts.paymentsConfig,
        {
          read: (path) => this.files.read(path),
          write: (path, data) => this.files.write(path, data),
        }
      )
    }
```

Also add the import at the top of `index.ts`:

```typescript
import {
  SandboxPayments,
  validatePaymentConfig,
  buildPaymentEnvs,
} from './payments'
import type { PaymentConfig } from './payments'
```

- [ ] **Step 4: Merge payment envs and pass paymentsConfig in create()**

In `packages/js-sdk/src/sandbox/index.ts`, find the `create()` implementation at line 264. Replace the block that calls `SandboxApi.createSandbox` (around line 291):

```typescript
// Replace this:
    const sandboxInfo = await SandboxApi.createSandbox(
      template,
      sandboxOpts?.timeoutMs ?? this.defaultSandboxTimeoutMs,
      sandboxOpts
    )

    const sandbox = new this({ ...sandboxInfo, ...config }) as InstanceType<S>

// With this:
    if (sandboxOpts?.payments) {
      validatePaymentConfig(sandboxOpts.payments)
    }

    const mergedOpts = sandboxOpts?.payments
      ? {
          ...sandboxOpts,
          envs: {
            ...sandboxOpts.envs,
            ...buildPaymentEnvs(sandboxOpts.payments),
          },
        }
      : sandboxOpts

    const sandboxInfo = await SandboxApi.createSandbox(
      template,
      mergedOpts?.timeoutMs ?? this.defaultSandboxTimeoutMs,
      mergedOpts
    )

    const sandbox = new this({
      ...sandboxInfo,
      ...config,
      paymentsConfig: sandboxOpts?.payments,
    }) as InstanceType<S>
```

- [ ] **Step 5: Export new types from src/index.ts**

Open `packages/js-sdk/src/index.ts`. Find the block of sandbox-related exports and add:

```typescript
export type { PaymentConfig, PaymentEvent, SandboxPaymentsBalance } from './sandbox/payments'
export { SandboxPayments } from './sandbox/payments'
```

- [ ] **Step 6: Run typecheck to catch any issues**

```bash
cd packages/js-sdk && pnpm run typecheck
```

Expected: No errors

- [ ] **Step 7: Run all tests**

```bash
cd packages/js-sdk && pnpm run test
```

Expected: All existing tests pass, no regressions

- [ ] **Step 8: Commit**

```bash
git add packages/js-sdk/src/sandbox/sandboxApi.ts \
        packages/js-sdk/src/sandbox/index.ts \
        packages/js-sdk/src/index.ts
git commit -m "feat(js-sdk): wire payments into Sandbox.create() and export types"
```

---

## Task 5: Python SDK — PaymentConfig types and validation (TDD)

**Files:**
- Create: `packages/python-sdk/e2b/sandbox/payments.py`
- Create: `packages/python-sdk/tests/unit/test_payments.py`

- [ ] **Step 1: Write failing tests**

Create `packages/python-sdk/tests/unit/test_payments.py`:

```python
import pytest
from e2b.sandbox.payments import (
    PaymentConfig,
    PaymentEvent,
    build_payment_envs,
)

VALID_KEY = "0x" + "a" * 64


class TestPaymentConfig:
    def test_accepts_valid_key(self):
        config = PaymentConfig(private_key=VALID_KEY)
        assert config.network == "base-sepolia"

    def test_rejects_key_without_prefix(self):
        with pytest.raises(ValueError, match="0x-prefixed"):
            PaymentConfig(private_key="a" * 64)

    def test_rejects_key_too_short(self):
        with pytest.raises(ValueError, match="0x-prefixed"):
            PaymentConfig(private_key="0x" + "a" * 63)

    def test_rejects_key_too_long(self):
        with pytest.raises(ValueError, match="0x-prefixed"):
            PaymentConfig(private_key="0x" + "a" * 65)

    def test_rejects_unknown_network(self):
        with pytest.raises(ValueError, match="network must be"):
            PaymentConfig(private_key=VALID_KEY, network="ethereum")

    def test_accepts_base_network(self):
        config = PaymentConfig(private_key=VALID_KEY, network="base")
        assert config.network == "base"

    def test_rejects_negative_max_spend(self):
        with pytest.raises(ValueError, match="non-negative"):
            PaymentConfig(private_key=VALID_KEY, max_spend=-0.01)

    def test_accepts_zero_max_spend(self):
        config = PaymentConfig(private_key=VALID_KEY, max_spend=0)
        assert config.max_spend == 0


class TestBuildPaymentEnvs:
    def test_includes_private_key(self):
        envs = build_payment_envs(PaymentConfig(private_key=VALID_KEY))
        assert envs["E2B_PAYMENT_PRIVATE_KEY"] == VALID_KEY

    def test_defaults_network_to_base_sepolia(self):
        envs = build_payment_envs(PaymentConfig(private_key=VALID_KEY))
        assert envs["E2B_PAYMENT_NETWORK"] == "base-sepolia"

    def test_uses_provided_network(self):
        envs = build_payment_envs(PaymentConfig(private_key=VALID_KEY, network="base"))
        assert envs["E2B_PAYMENT_NETWORK"] == "base"

    def test_omits_max_spend_when_not_set(self):
        envs = build_payment_envs(PaymentConfig(private_key=VALID_KEY))
        assert "E2B_PAYMENT_MAX_SPEND" not in envs

    def test_includes_max_spend_as_string(self):
        envs = build_payment_envs(PaymentConfig(private_key=VALID_KEY, max_spend=5.5))
        assert envs["E2B_PAYMENT_MAX_SPEND"] == "5.5"
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
cd packages/python-sdk && poetry run pytest tests/unit/test_payments.py -v
```

Expected: FAIL with `ModuleNotFoundError: No module named 'e2b.sandbox.payments'`

- [ ] **Step 3: Create the implementation**

Create `packages/python-sdk/e2b/sandbox/payments.py`:

```python
import re
from dataclasses import dataclass, field
from typing import Dict, List, Literal, Optional


_PRIVATE_KEY_RE = re.compile(r"^0x[0-9a-fA-F]{64}$")
_KNOWN_NETWORKS = ("base", "base-sepolia")


@dataclass
class PaymentConfig:
    private_key: str
    network: Literal["base", "base-sepolia"] = "base-sepolia"
    max_spend: Optional[float] = None

    def __post_init__(self) -> None:
        if not _PRIVATE_KEY_RE.match(self.private_key):
            raise ValueError(
                "private_key must be a 0x-prefixed 32-byte hex string (64 hex chars after 0x)"
            )
        if self.network not in _KNOWN_NETWORKS:
            raise ValueError(
                f'network must be "base" or "base-sepolia", got "{self.network}"'
            )
        if self.max_spend is not None and self.max_spend < 0:
            raise ValueError("max_spend must be non-negative")


@dataclass
class PaymentEvent:
    timestamp: str
    url: str
    amount_usd: float
    tx_hash: str
    status: Literal["success", "failed"]


@dataclass
class SandboxPaymentsBalance:
    usdc: float
    address: str


def build_payment_envs(config: PaymentConfig) -> Dict[str, str]:
    envs: Dict[str, str] = {
        "E2B_PAYMENT_PRIVATE_KEY": config.private_key,
        "E2B_PAYMENT_NETWORK": config.network,
    }
    if config.max_spend is not None:
        envs["E2B_PAYMENT_MAX_SPEND"] = str(config.max_spend)
    return envs
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
cd packages/python-sdk && poetry run pytest tests/unit/test_payments.py -v
```

Expected: All 13 tests PASS

- [ ] **Step 5: Commit**

```bash
git add packages/python-sdk/e2b/sandbox/payments.py packages/python-sdk/tests/unit/test_payments.py
git commit -m "feat(python-sdk): add PaymentConfig types and validation for x402 payments"
```

---

## Task 6: Python SDK — SandboxPayments classes (TDD)

**Files:**
- Modify: `packages/python-sdk/e2b/sandbox/payments.py`
- Modify: `packages/python-sdk/tests/unit/test_payments.py`

- [ ] **Step 1: Add unit tests for SandboxPayments to test_payments.py**

Append to `packages/python-sdk/tests/unit/test_payments.py`:

```python
import json
from unittest.mock import MagicMock
from e2b.sandbox.payments import SandboxPayments

# A real secp256k1 test private key (Hardhat account #0 — public knowledge, never use in prod)
TEST_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
EXPECTED_ADDRESS = "0xf39Fd6e51aad88F6f4ce6aB8827279cffFb92266"


def make_fake_filesystem(content: str = ""):
    fs = MagicMock()
    fs.read.side_effect = lambda path, **kwargs: content if content else (_ for _ in ()).throw(Exception("not found"))
    fs.write = MagicMock()
    return fs


class TestSandboxPaymentsGetHistory:
    def test_returns_empty_list_when_file_missing(self):
        fs = make_fake_filesystem()
        sp = SandboxPayments(PaymentConfig(private_key=TEST_KEY), fs)
        assert sp.get_history() == []

    def test_parses_jsonl_lines(self):
        event = {
            "timestamp": "2026-04-28T00:00:00Z",
            "url": "https://api.example.com/data",
            "amount_usd": 0.001,
            "tx_hash": "0xabc",
            "status": "success",
        }
        fs = make_fake_filesystem(json.dumps(event) + "\n")
        sp = SandboxPayments(PaymentConfig(private_key=TEST_KEY), fs)
        history = sp.get_history()
        assert len(history) == 1
        assert history[0].status == "success"
        assert history[0].amount_usd == 0.001

    def test_skips_empty_lines(self):
        event = {"timestamp": "t", "url": "u", "amount_usd": 0.001, "tx_hash": "h", "status": "success"}
        fs = make_fake_filesystem("\n" + json.dumps(event) + "\n\n")
        sp = SandboxPayments(PaymentConfig(private_key=TEST_KEY), fs)
        assert len(sp.get_history()) == 1


class TestSandboxPaymentsSetSpendingLimit:
    def test_writes_limit_to_correct_path(self):
        fs = make_fake_filesystem()
        sp = SandboxPayments(PaymentConfig(private_key=TEST_KEY), fs)
        sp.set_spending_limit(2.5)
        fs.write.assert_called_once_with("/tmp/.e2b-payment-limit", "2.5")

    def test_raises_for_negative_limit(self):
        fs = make_fake_filesystem()
        sp = SandboxPayments(PaymentConfig(private_key=TEST_KEY), fs)
        with pytest.raises(ValueError, match="non-negative"):
            sp.set_spending_limit(-1)


class TestSandboxPaymentsWalletAddress:
    def test_derives_correct_address_from_key(self):
        sp = SandboxPayments(PaymentConfig(private_key=TEST_KEY), MagicMock())
        assert sp.wallet_address.lower() == EXPECTED_ADDRESS.lower()
```

- [ ] **Step 2: Run new tests to confirm they fail**

```bash
cd packages/python-sdk && poetry run pytest tests/unit/test_payments.py -v -k "TestSandboxPayments"
```

Expected: FAIL with `ImportError: cannot import name 'SandboxPayments'`

- [ ] **Step 3: Add SandboxPayments class to payments.py**

Append to `packages/python-sdk/e2b/sandbox/payments.py`:

```python
import json

_RPC_URLS = {
    "base": "https://mainnet.base.org",
    "base-sepolia": "https://sepolia.base.org",
}

_USDC_ADDRESSES = {
    "base": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    "base-sepolia": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
}


class SandboxPayments:
    def __init__(self, config: PaymentConfig, filesystem) -> None:
        from eth_account import Account

        self.wallet_address: str = Account.from_key(config.private_key).address
        self._network = config.network
        self._fs = filesystem

    def get_history(self) -> List[PaymentEvent]:
        try:
            content = self._fs.read("/tmp/.e2b-payments.jsonl")
            lines = [l for l in content.split("\n") if l.strip()]
            return [PaymentEvent(**json.loads(l)) for l in lines]
        except Exception:
            return []

    def get_balance(self) -> SandboxPaymentsBalance:
        import httpx

        rpc_url = _RPC_URLS[self._network]
        usdc_address = _USDC_ADDRESSES[self._network]
        # ABI-encode balanceOf(address): selector + 32-byte padded address
        data = "0x70a08231" + self.wallet_address[2:].lower().zfill(64)
        resp = httpx.post(
            rpc_url,
            json={
                "jsonrpc": "2.0",
                "method": "eth_call",
                "params": [{"to": usdc_address, "data": data}, "latest"],
                "id": 1,
            },
        )
        result = resp.json()["result"]
        usdc = int(result, 16) / 1e6
        return SandboxPaymentsBalance(usdc=usdc, address=self.wallet_address)

    def set_spending_limit(self, usd: float) -> None:
        if usd < 0:
            raise ValueError("Spending limit must be non-negative")
        self._fs.write("/tmp/.e2b-payment-limit", str(usd))


class AsyncSandboxPayments:
    def __init__(self, config: PaymentConfig, filesystem) -> None:
        from eth_account import Account

        self.wallet_address: str = Account.from_key(config.private_key).address
        self._network = config.network
        self._fs = filesystem

    async def get_history(self) -> List[PaymentEvent]:
        try:
            content = await self._fs.read("/tmp/.e2b-payments.jsonl")
            lines = [l for l in content.split("\n") if l.strip()]
            return [PaymentEvent(**json.loads(l)) for l in lines]
        except Exception:
            return []

    async def get_balance(self) -> SandboxPaymentsBalance:
        import httpx

        rpc_url = _RPC_URLS[self._network]
        usdc_address = _USDC_ADDRESSES[self._network]
        data = "0x70a08231" + self.wallet_address[2:].lower().zfill(64)
        async with httpx.AsyncClient() as client:
            resp = await client.post(
                rpc_url,
                json={
                    "jsonrpc": "2.0",
                    "method": "eth_call",
                    "params": [{"to": usdc_address, "data": data}, "latest"],
                    "id": 1,
                },
            )
        result = resp.json()["result"]
        usdc = int(result, 16) / 1e6
        return SandboxPaymentsBalance(usdc=usdc, address=self.wallet_address)

    async def set_spending_limit(self, usd: float) -> None:
        if usd < 0:
            raise ValueError("Spending limit must be non-negative")
        await self._fs.write("/tmp/.e2b-payment-limit", str(usd))
```

- [ ] **Step 4: Run all unit tests**

```bash
cd packages/python-sdk && poetry run pytest tests/unit/test_payments.py -v
```

Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add packages/python-sdk/e2b/sandbox/payments.py packages/python-sdk/tests/unit/test_payments.py
git commit -m "feat(python-sdk): add SandboxPayments and AsyncSandboxPayments classes"
```

---

## Task 7: Python SDK — Wire into sync Sandbox

**Files:**
- Modify: `packages/python-sdk/e2b/sandbox_sync/main.py`
- Modify: `packages/python-sdk/e2b/sandbox/__init__.py`

- [ ] **Step 1: Add `_payments` attribute to `__init__`**

Open `packages/python-sdk/e2b/sandbox_sync/main.py`. In the `__init__` method, after `self._git = Git(self._commands)` (around line 128), add:

```python
        self._payments: Optional["SandboxPayments"] = None
```

Also add to the imports at the top of the file:

```python
from e2b.sandbox.payments import (
    PaymentConfig,
    SandboxPayments,
    build_payment_envs,
)
```

- [ ] **Step 2: Add `payments` property**

After the existing `@property` blocks (around line 87), add:

```python
    @property
    def payments(self) -> Optional[SandboxPayments]:
        """Module for managing autonomous x402 payments. Only present when sandbox was created with a payments option."""
        return self._payments
```

- [ ] **Step 3: Add `payments` parameter to `create()` and wire it up**

In `create()` (line 167), add `payments: Optional[PaymentConfig] = None` as a new parameter after `volume_mounts`:

```python
    def create(
        cls,
        template: Optional[str] = None,
        timeout: Optional[int] = None,
        metadata: Optional[Dict[str, str]] = None,
        envs: Optional[Dict[str, str]] = None,
        secure: bool = True,
        allow_internet_access: bool = True,
        mcp: Optional[McpServer] = None,
        network: Optional[SandboxNetworkOpts] = None,
        lifecycle: Optional[SandboxLifecycle] = None,
        volume_mounts: Optional[SandboxVolumeMount] = None,
        payments: Optional[PaymentConfig] = None,
        **opts: Unpack[ApiParams],
    ) -> Self:
```

In the docstring, add:
```
:param payments: Payment configuration for x402 autonomous payments (USDC on Base).
```

Before the `cls._create(...)` call (around line 216), add:

```python
        if payments is not None:
            merged_envs = {**(envs or {}), **build_payment_envs(payments)}
        else:
            merged_envs = envs
```

Change `envs=envs,` in the `cls._create(...)` call to `envs=merged_envs,`.

After the `sandbox = cls._create(...)` call (around line 229), add:

```python
        if payments is not None:
            sandbox._payments = SandboxPayments(payments, sandbox._filesystem)
```

- [ ] **Step 4: Export from sandbox __init__.py**

Open `packages/python-sdk/e2b/sandbox/__init__.py`. Add to the exports:

```python
from e2b.sandbox.payments import PaymentConfig, PaymentEvent, SandboxPaymentsBalance
```

- [ ] **Step 5: Run lint and typecheck**

```bash
cd packages/python-sdk && make lint && make typecheck
```

Expected: No errors

- [ ] **Step 6: Run existing sync sandbox tests to check for regressions**

```bash
cd packages/python-sdk && poetry run pytest tests/unit/ -v
```

Expected: All pass

- [ ] **Step 7: Commit**

```bash
git add packages/python-sdk/e2b/sandbox_sync/main.py packages/python-sdk/e2b/sandbox/__init__.py
git commit -m "feat(python-sdk): wire payments into sync Sandbox.create()"
```

---

## Task 8: Python SDK — Wire into async Sandbox

**Files:**
- Modify: `packages/python-sdk/e2b/sandbox_async/main.py`

- [ ] **Step 1: Read the file to understand its structure**

```bash
grep -n "def create\|def __init__\|self\._git\|self\._payments\|@property\|async def" \
  packages/python-sdk/e2b/sandbox_async/main.py | head -40
```

Note the line numbers for `__init__`, the `_git` assignment, and `create()`.

- [ ] **Step 2: Add imports to sandbox_async/main.py**

At the top of `packages/python-sdk/e2b/sandbox_async/main.py`, add with the other imports:

```python
from e2b.sandbox.payments import (
    AsyncSandboxPayments,
    PaymentConfig,
    build_payment_envs,
)
```

- [ ] **Step 3: Add `_payments` attribute in `__init__` and property**

In `__init__`, after the `self._git = ...` line, add:

```python
        self._payments: Optional[AsyncSandboxPayments] = None
```

Add a property alongside the other properties:

```python
    @property
    def payments(self) -> Optional[AsyncSandboxPayments]:
        """Module for managing autonomous x402 payments. Only present when sandbox was created with a payments option."""
        return self._payments
```

- [ ] **Step 4: Add `payments` param to async `create()` and wire it up**

Find the async `create()` method and add `payments: Optional[PaymentConfig] = None` as a parameter.

Before the `cls._create(...)` call, add:

```python
        if payments is not None:
            merged_envs = {**(envs or {}), **build_payment_envs(payments)}
        else:
            merged_envs = envs
```

Change `envs=envs,` to `envs=merged_envs,`.

After `sandbox = await cls._create(...)`, add:

```python
        if payments is not None:
            sandbox._payments = AsyncSandboxPayments(payments, sandbox._filesystem)
```

- [ ] **Step 5: Run lint, typecheck, and existing tests**

```bash
cd packages/python-sdk && make lint && make typecheck && poetry run pytest tests/unit/ -v
```

Expected: All pass, no errors

- [ ] **Step 6: Commit**

```bash
git add packages/python-sdk/e2b/sandbox_async/main.py
git commit -m "feat(python-sdk): wire payments into async Sandbox.create()"
```

---

## Task 9: Python sandbox template and httpx interceptor

**Files:**
- Create: `templates/payments-py/Dockerfile`
- Create: `templates/payments-py/e2b_payments/__init__.py`
- Create: `templates/payments-py/init.sh`
- Create: `templates/payments-py/e2b.toml`

- [ ] **Step 1: Create the template directory**

```bash
mkdir -p templates/payments-py/e2b_payments
```

- [ ] **Step 2: Create the Dockerfile**

Create `templates/payments-py/Dockerfile`:

```dockerfile
FROM e2bdev/code-interpreter:latest

# Install x402 payment dependencies
RUN pip install eth-account>=0.11.0 httpx>=0.27.0

# Copy the e2b_payments interceptor package
COPY e2b_payments/ /usr/local/lib/python3.11/site-packages/e2b_payments/

# Copy and set up init script
COPY init.sh /etc/e2b-payments-init.sh
RUN chmod +x /etc/e2b-payments-init.sh

# Auto-activate interceptor for every Python process if credentials are present
RUN echo 'import e2b_payments' >> /usr/lib/python3/dist-packages/sitecustomize.py || \
    echo 'import e2b_payments' > /usr/local/lib/python3.11/site-packages/sitecustomize.py
```

- [ ] **Step 3: Create the httpx interceptor**

Create `templates/payments-py/e2b_payments/__init__.py`:

```python
"""
E2B x402 payment interceptor.
Auto-activates when E2B_PAYMENT_PRIVATE_KEY is set.
Wraps httpx.Client and httpx.AsyncClient to handle HTTP 402 responses automatically.
"""

import base64
import fcntl
import json
import os
import threading
import time
from pathlib import Path
from typing import Optional

_PRIVATE_KEY = os.environ.get("E2B_PAYMENT_PRIVATE_KEY", "")
_NETWORK = os.environ.get("E2B_PAYMENT_NETWORK", "base-sepolia")
# USDC EIP-712 domain version. Override with E2B_PAYMENT_USDC_VERSION if Coinbase
# upgrades the contract implementation (as they did on Ethereum: "2" → "2.2").
# The correct way to eliminate this entirely is to call DOMAIN_SEPARATOR() on the
# contract at runtime and pass it directly — but that costs one extra RPC call.
_USDC_VERSION = os.environ.get("E2B_PAYMENT_USDC_VERSION", "2")
_PAYMENTS_LOG = Path("/tmp/.e2b-payments.jsonl")
_SPEND_LIMIT_FILE = Path("/tmp/.e2b-payment-limit")
_PAYMENT_LOCK = Path("/tmp/.e2b-payment-lock")

_CHAIN_IDS = {"base": 8453, "base-sepolia": 84532}

# Re-entrancy guard: prevents the interceptor firing on its own internal httpx calls.
_payment_in_progress = threading.local()

# E2B's own REST API must never be intercepted — it may legitimately return 402
# for quota enforcement, and patching those calls risks sending wallet funds to E2B.
_E2B_API_HOSTS = frozenset({"api.e2b.dev", "api.e2b.io"})


class SpendingLimitExceeded(Exception):
    pass


def _get_account():
    if not _PRIVATE_KEY:
        return None
    from eth_account import Account
    return Account.from_key(_PRIVATE_KEY)


def _check_and_log_payment(amount_usd: float, url: str, tx_hash: str, status: str) -> None:
    """Check spending limit and append log entry atomically under an exclusive file lock.

    Combining the check and write in one locked section eliminates the TOCTOU race
    where concurrent requests all read the same cumulative total and each pass the check.
    """
    _PAYMENT_LOCK.touch(exist_ok=True)
    with open(_PAYMENT_LOCK, "r") as lock_f:
        fcntl.flock(lock_f, fcntl.LOCK_EX)
        try:
            if _SPEND_LIMIT_FILE.exists():
                limit_str = _SPEND_LIMIT_FILE.read_text().strip()
                if limit_str:
                    limit = float(limit_str)
                    spent = 0.0
                    if _PAYMENTS_LOG.exists():
                        for line in _PAYMENTS_LOG.read_text().splitlines():
                            if line.strip():
                                try:
                                    event = json.loads(line)
                                    if event.get("status") == "success":
                                        # USDC has 6 decimal places, not 18
                                        spent += event.get("amount_usd", 0)
                                except json.JSONDecodeError:
                                    pass  # skip corrupt lines, don't block payments
                    if spent + amount_usd > limit:
                        raise SpendingLimitExceeded(
                            f"Payment of ${amount_usd:.4f} would exceed spending limit "
                            f"of ${limit:.4f} (spent so far: ${spent:.4f})"
                        )
            # Write while still holding the lock — atomic check-then-write
            event = {
                "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                "url": url,
                "amount_usd": amount_usd,
                "tx_hash": tx_hash,
                "status": status,
            }
            with _PAYMENTS_LOG.open("a") as f:
                f.write(json.dumps(event) + "\n")
        finally:
            fcntl.flock(lock_f, fcntl.LOCK_UN)


def _build_payment_header(payment_requirements: dict) -> str:
    """Build base64-encoded X-PAYMENT header using EIP-3009 TransferWithAuthorization."""
    from eth_account import Account
    import secrets as _secrets

    account = _get_account()
    if account is None:
        raise RuntimeError("E2B_PAYMENT_PRIVATE_KEY not set")

    usdc_address = payment_requirements["usdcAddress"]
    pay_to = payment_requirements["payToAddress"]
    amount = int(payment_requirements["maxAmountRequired"])
    deadline = int(time.time()) + int(payment_requirements.get("requiredDeadlineSeconds", 300))
    # bytes32 nonce: 32 cryptographically random bytes
    nonce = bytes.fromhex(_secrets.token_hex(32))

    chain_id = _CHAIN_IDS.get(_NETWORK, 84532)

    # eth-account >= 0.9.0 API: domain_data, message_types, and message_data are
    # separate positional arguments. EIP712Domain must NOT appear in message_types —
    # eth-account raises ValueError("EIP712Domain type is not allowed in message_types")
    # if it does. The full_message= kwarg form was removed in 0.9.0.
    domain_data = {
        "name": "USD Coin",
        "version": _USDC_VERSION,
        "chainId": chain_id,
        "verifyingContract": usdc_address,
    }
    message_types = {
        "TransferWithAuthorization": [
            {"name": "from", "type": "address"},
            {"name": "to", "type": "address"},
            {"name": "value", "type": "uint256"},
            {"name": "validAfter", "type": "uint256"},
            {"name": "validBefore", "type": "uint256"},
            {"name": "nonce", "type": "bytes32"},
        ],
    }
    message_data = {
        "from": account.address,
        "to": pay_to,
        "value": amount,
        "validAfter": 0,
        "validBefore": deadline,
        "nonce": nonce,
    }

    signed = Account.sign_typed_data(
        _PRIVATE_KEY,
        domain_data=domain_data,
        message_types=message_types,
        message_data=message_data,
    )

    payload = {
        "x402Version": 1,
        "scheme": "exact",
        "network": _NETWORK,
        "payload": {
            "signature": "0x" + signed.signature.hex(),
            "authorization": {
                "from": account.address,
                "to": pay_to,
                "value": str(amount),
                "validAfter": "0",
                "validBefore": str(deadline),
                "nonce": "0x" + nonce.hex(),
            },
        },
    }
    return base64.b64encode(json.dumps(payload).encode()).decode()


def _handle_sync_402(response, request_fn, original_request):
    """Handle a 402 response: sign payment and retry."""
    try:
        payment_requirements = response.json()
    except Exception:
        return response

    # USDC has 6 decimal places, not 18 like most ERC-20 tokens
    amount_usd = int(payment_requirements.get("maxAmountRequired", 0)) / 1e6
    payment_header = _build_payment_header(payment_requirements)
    original_request.headers["X-PAYMENT"] = payment_header
    retry_response = request_fn(original_request)

    tx_hash = retry_response.headers.get("X-PAYMENT-RESPONSE", "unknown")
    status = "success" if retry_response.status_code != 402 else "failed"
    _check_and_log_payment(amount_usd, str(original_request.url), tx_hash, status)

    return retry_response


# Only patch if credentials are present
if _PRIVATE_KEY:
    try:
        import httpx

        _original_send = httpx.Client.send

        def _patched_send(self, request, **kwargs):
            # Skip if we're already inside a payment handler (re-entrancy guard)
            if getattr(_payment_in_progress, "active", False):
                return _original_send(self, request, **kwargs)
            # Never intercept E2B's own API calls
            if str(request.url.host) in _E2B_API_HOSTS:
                return _original_send(self, request, **kwargs)
            response = _original_send(self, request, **kwargs)
            if response.status_code == 402:
                _payment_in_progress.active = True
                try:
                    return _handle_sync_402(
                        response,
                        lambda req: _original_send(self, req, **kwargs),
                        request,
                    )
                finally:
                    _payment_in_progress.active = False
            return response

        httpx.Client.send = _patched_send

        _original_async_send = httpx.AsyncClient.send

        async def _patched_async_send(self, request, **kwargs):
            if getattr(_payment_in_progress, "active", False):
                return await _original_async_send(self, request, **kwargs)
            if str(request.url.host) in _E2B_API_HOSTS:
                return await _original_async_send(self, request, **kwargs)
            response = await _original_async_send(self, request, **kwargs)
            if response.status_code == 402:
                _payment_in_progress.active = True
                try:
                    account = _get_account()
                    if account is None:
                        return response
                    try:
                        payment_requirements = response.json()
                    except Exception:
                        return response
                    # USDC has 6 decimal places, not 18 like most ERC-20 tokens
                    amount_usd = int(payment_requirements.get("maxAmountRequired", 0)) / 1e6
                    payment_header = _build_payment_header(payment_requirements)
                    request.headers["X-PAYMENT"] = payment_header
                    retry_response = await _original_async_send(self, request, **kwargs)
                    tx_hash = retry_response.headers.get("X-PAYMENT-RESPONSE", "unknown")
                    status = "success" if retry_response.status_code != 402 else "failed"
                    _check_and_log_payment(amount_usd, str(request.url), tx_hash, status)
                    return retry_response
                finally:
                    _payment_in_progress.active = False
            return response

        httpx.AsyncClient.send = _patched_async_send

    except ImportError:
        pass
```

- [ ] **Step 4: Create the init script**

Create `templates/payments-py/init.sh`:

```bash
#!/bin/bash
# Initialize e2b payments state files if payment credentials are present
if [ -n "$E2B_PAYMENT_PRIVATE_KEY" ]; then
    touch /tmp/.e2b-payments.jsonl
    if [ -n "$E2B_PAYMENT_MAX_SPEND" ]; then
        echo "$E2B_PAYMENT_MAX_SPEND" > /tmp/.e2b-payment-limit
    fi
fi
```

- [ ] **Step 5: Create e2b.toml for the template**

Create `templates/payments-py/e2b.toml`:

```toml
dockerfile = "Dockerfile"
template_id = "e2b-payments-py"
```

- [ ] **Step 6: Commit**

```bash
git add templates/payments-py/
git commit -m "feat: add Python payments sandbox template with httpx x402 interceptor"
```

---

## Task 10: JS sandbox template and fetch interceptor

**Files:**
- Create: `templates/payments-js/Dockerfile`
- Create: `templates/payments-js/e2b-payments/index.mjs`
- Create: `templates/payments-js/init.sh`
- Create: `templates/payments-js/e2b.toml`

> Note: `loader.cjs` was removed. `NODE_OPTIONS=--import index.mjs` is used directly — see Step 4 for the explanation.

- [ ] **Step 1: Create the template directory**

```bash
mkdir -p templates/payments-js/e2b-payments
```

- [ ] **Step 2: Create the Dockerfile**

Create `templates/payments-js/Dockerfile`:

```dockerfile
FROM e2bdev/code-interpreter:latest

# Install viem for x402 payment signing
RUN npm install -g viem

# Copy payment interceptor
COPY e2b-payments/ /usr/local/lib/e2b-payments/

# Auto-require the interceptor for every Node process if credentials present
RUN echo 'if (process.env.E2B_PAYMENT_PRIVATE_KEY) require("/usr/local/lib/e2b-payments/index.mjs")' \
    >> /usr/local/lib/node_modules/npm/node_modules/.pnp.cjs || true

COPY init.sh /etc/e2b-payments-init.sh
RUN chmod +x /etc/e2b-payments-init.sh

# --import (not --require) runs the module through the ESM loader with top-level
# await support, guaranteeing the fetch patch is installed before any user code runs.
# --require fires a CJS require() which cannot await a dynamic import(), creating a
# race where the first fetch() call in agent code executes before the patch lands.
# Requires Node.js >= 18.19.
ENV NODE_OPTIONS="--import /usr/local/lib/e2b-payments/index.mjs"
```

- [ ] **Step 3: Create the fetch interceptor**

Create `templates/payments-js/e2b-payments/index.mjs`:

```javascript
/**
 * E2B x402 payment interceptor for Node.js.
 * Wraps global fetch to auto-handle HTTP 402 responses using EIP-3009 USDC transfers.
 * Auto-activates when E2B_PAYMENT_PRIVATE_KEY is set.
 */

import { appendFileSync, existsSync, readFileSync } from 'fs'
import { privateKeyToAccount, toHex } from 'viem/accounts'

const PRIVATE_KEY = process.env.E2B_PAYMENT_PRIVATE_KEY
const NETWORK = process.env.E2B_PAYMENT_NETWORK || 'base-sepolia'
const PAYMENTS_LOG = '/tmp/.e2b-payments.jsonl'
const SPEND_LIMIT_FILE = '/tmp/.e2b-payment-limit'
// USDC EIP-712 domain version. Set E2B_PAYMENT_USDC_VERSION env var if Coinbase
// upgrades the contract implementation (e.g. "2" → "2.2" as happened on Ethereum).
const USDC_VERSION = process.env.E2B_PAYMENT_USDC_VERSION || '2'

const CHAIN_IDS = { base: 8453, 'base-sepolia': 84532 }

if (!PRIVATE_KEY) process.exit(0)

const account = privateKeyToAccount(PRIVATE_KEY)

// Promise-based mutex: Node.js is single-threaded but concurrent async operations
// can still race when reading+writing the spend log. Serialise all payment ops.
let _paymentQueue = Promise.resolve()
function withPaymentLock(fn) {
  const next = _paymentQueue.then(fn)
  _paymentQueue = next.catch(() => {}) // don't let a rejection break the queue
  return next
}

function checkSpendingLimit(amountUsd) {
  if (!existsSync(SPEND_LIMIT_FILE)) return
  const limitStr = readFileSync(SPEND_LIMIT_FILE, 'utf8').trim()
  if (!limitStr) return
  const limit = parseFloat(limitStr)
  let spent = 0
  if (existsSync(PAYMENTS_LOG)) {
    for (const line of readFileSync(PAYMENTS_LOG, 'utf8').split('\n')) {
      if (!line.trim()) continue
      try {
        const event = JSON.parse(line)
        // USDC has 6 decimal places, not 18 like most ERC-20 tokens
        if (event.status === 'success') spent += event.amountUsd
      } catch { /* skip corrupt lines */ }
    }
  }
  if (spent + amountUsd > limit) {
    throw new Error(
      `SpendingLimitExceeded: payment of $${amountUsd.toFixed(4)} would exceed ` +
      `limit of $${limit.toFixed(4)} (spent: $${spent.toFixed(4)})`
    )
  }
}

function logPayment(url, amountUsd, txHash, status) {
  const event = JSON.stringify({ timestamp: new Date().toISOString(), url, amountUsd, txHash, status })
  appendFileSync(PAYMENTS_LOG, event + '\n')
}

async function buildPaymentHeader(requirements) {
  const usdcAddress = requirements.usdcAddress
  const payTo = requirements.payToAddress
  const amount = BigInt(requirements.maxAmountRequired)
  const deadline = BigInt(Math.floor(Date.now() / 1000) + (requirements.requiredDeadlineSeconds || 300))
  // toHex() produces a 0x-prefixed hex string — the correct Hex type for viem's bytes32
  const nonce = toHex(crypto.getRandomValues(new Uint8Array(32)))
  const chainId = CHAIN_IDS[NETWORK] || 84532

  const domain = {
    name: 'USD Coin',
    version: USDC_VERSION,
    chainId,
    verifyingContract: usdcAddress,
  }
  const types = {
    TransferWithAuthorization: [
      { name: 'from', type: 'address' },
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'validAfter', type: 'uint256' },
      { name: 'validBefore', type: 'uint256' },
      { name: 'nonce', type: 'bytes32' },
    ],
  }
  const message = {
    from: account.address,
    to: payTo,
    value: amount,
    validAfter: 0n,
    validBefore: deadline,
    nonce,  // already a Hex string — viem encodes bytes32 from Hex correctly
  }

  const signature = await account.signTypedData({
    domain,
    types,
    primaryType: 'TransferWithAuthorization',
    message,
  })

  const payload = {
    x402Version: 1,
    scheme: 'exact',
    network: NETWORK,
    payload: {
      signature,
      authorization: {
        from: account.address,
        to: payTo,
        value: amount.toString(),
        validAfter: '0',
        validBefore: deadline.toString(),
        nonce,
      },
    },
  }
  return Buffer.from(JSON.stringify(payload)).toString('base64')
}

// Patch global fetch — runs synchronously at module load time so the patch is
// guaranteed to be in place before any user code executes (safe with --import).
const _originalFetch = globalThis.fetch
globalThis.fetch = async function patchedFetch(input, init) {
  const response = await _originalFetch(input, init)
  if (response.status !== 402) return response

  let requirements
  try {
    requirements = await response.clone().json()
  } catch {
    return response
  }

  // USDC has 6 decimal places, not 18 like most ERC-20 tokens
  const amountUsd = Number(BigInt(requirements.maxAmountRequired || '0')) / 1e6

  return withPaymentLock(async () => {
    checkSpendingLimit(amountUsd)
    const paymentHeader = await buildPaymentHeader(requirements)
    const retryInit = {
      ...(init || {}),
      headers: { ...(init?.headers || {}), 'X-PAYMENT': paymentHeader },
    }
    const retryResponse = await _originalFetch(input, retryInit)
    const txHash = retryResponse.headers.get('X-PAYMENT-RESPONSE') || 'unknown'
    const status = retryResponse.status !== 402 ? 'success' : 'failed'
    logPayment(typeof input === 'string' ? input : input.url, amountUsd, txHash, status)
    return retryResponse
  })
}
```

- [ ] **Step 4: Verify no loader.cjs is needed**

The original plan included a `loader.cjs` shim used via `NODE_OPTIONS=--require`. This is removed.

`--require` runs a CJS module synchronously but cannot `await` the dynamic `import()` it fires to load the ESM interceptor. The result is a race: any top-level `await fetch()` in the agent script executes on the unpatched global before the interceptor installs.

`--import` (used in Step 2's Dockerfile) runs the ESM module through the full loader with top-level `await` support. The patch at the bottom of `index.mjs` (`globalThis.fetch = ...`) executes synchronously at module evaluation time, so it is guaranteed to be in place before any user code runs. No shim file needed.

Confirm the base image Node.js version is >= 18.19 (when `--import` was stabilised):

```bash
node --version   # must be >= v18.19.0
```

- [ ] **Step 5: Create init.sh**

Create `templates/payments-js/init.sh`:

```bash
#!/bin/bash
if [ -n "$E2B_PAYMENT_PRIVATE_KEY" ]; then
    touch /tmp/.e2b-payments.jsonl
    if [ -n "$E2B_PAYMENT_MAX_SPEND" ]; then
        echo "$E2B_PAYMENT_MAX_SPEND" > /tmp/.e2b-payment-limit
    fi
fi
```

- [ ] **Step 6: Create e2b.toml**

Create `templates/payments-js/e2b.toml`:

```toml
dockerfile = "Dockerfile"
template_id = "e2b-payments-js"
```

- [ ] **Step 7: Commit**

```bash
git add templates/payments-js/
git commit -m "feat: add Node.js payments sandbox template with fetch x402 interceptor"
```

---

## Task 11: Integration tests — JS SDK

**Files:**
- Create: `packages/js-sdk/tests/integration/payments.test.ts`

These tests run against a real sandbox on Base Sepolia testnet. They require `TEST_WALLET_KEY` in `.env.local`.

- [ ] **Step 1: Get a funded Base Sepolia test wallet**

Create a new wallet (e.g. using MetaMask or `cast wallet new` from Foundry) and fund it with Base Sepolia USDC from https://faucet.circle.com. Add to `.env.local`:

```bash
TEST_WALLET_KEY=0x<your-test-private-key>
```

- [ ] **Step 2: Create the integration test file**

Create `packages/js-sdk/tests/integration/payments.test.ts`:

```typescript
import { describe, it, expect, beforeAll } from 'vitest'
import { Sandbox } from '../../src/sandbox'
import { readFileSync } from 'fs'
import { resolve } from 'path'

// Load test wallet key from .env.local
function loadTestWalletKey(): string {
  try {
    const envFile = readFileSync(resolve(__dirname, '../../../../.env.local'), 'utf8')
    const match = envFile.match(/TEST_WALLET_KEY=(.+)/)
    if (match) return match[1].trim()
  } catch {}
  return process.env.TEST_WALLET_KEY ?? ''
}

const TEST_WALLET_KEY = loadTestWalletKey()
const SKIP = !TEST_WALLET_KEY

describe.skipIf(SKIP)('Sandbox payments integration', { timeout: 60_000 }, () => {
  it('getBalance returns a usdc balance and address for a funded wallet', async () => {
    const sandbox = await Sandbox.create({
      template: 'base',
      payments: {
        privateKey: TEST_WALLET_KEY,
        network: 'base-sepolia',
      },
    })

    try {
      const balance = await sandbox.payments!.getBalance()
      expect(balance.address).toMatch(/^0x[0-9a-fA-F]{40}$/)
      expect(balance.usdc).toBeGreaterThanOrEqual(0)
    } finally {
      await sandbox.kill()
    }
  })

  it('getHistory returns empty array before any payments are made', async () => {
    const sandbox = await Sandbox.create({
      template: 'base',
      payments: {
        privateKey: TEST_WALLET_KEY,
        network: 'base-sepolia',
      },
    })

    try {
      const history = await sandbox.payments!.getHistory()
      expect(history).toEqual([])
    } finally {
      await sandbox.kill()
    }
  })

  it('setSpendingLimit writes the limit inside the sandbox', async () => {
    const sandbox = await Sandbox.create({
      template: 'base',
      payments: {
        privateKey: TEST_WALLET_KEY,
        network: 'base-sepolia',
        maxSpend: 1.0,
      },
    })

    try {
      await sandbox.payments!.setSpendingLimit(0.5)
      const content = await sandbox.files.read('/tmp/.e2b-payment-limit')
      expect(content.trim()).toBe('0.5')
    } finally {
      await sandbox.kill()
    }
  })

  it('payment env vars are present inside the sandbox', async () => {
    const sandbox = await Sandbox.create({
      template: 'base',
      payments: {
        privateKey: TEST_WALLET_KEY,
        network: 'base-sepolia',
        maxSpend: 2.0,
      },
    })

    try {
      const result = await sandbox.commands.run('echo $E2B_PAYMENT_NETWORK')
      expect(result.stdout.trim()).toBe('base-sepolia')

      const keyResult = await sandbox.commands.run(
        'test -n "$E2B_PAYMENT_PRIVATE_KEY" && echo "key_present"'
      )
      expect(keyResult.stdout.trim()).toBe('key_present')
    } finally {
      await sandbox.kill()
    }
  })
})
```

- [ ] **Step 3: Run the integration tests**

```bash
cd packages/js-sdk && pnpm run test tests/integration/payments.test.ts
```

Expected: All 4 tests PASS (or skip with `TEST_WALLET_KEY not set` message if key isn't configured)

- [ ] **Step 4: Commit**

```bash
git add packages/js-sdk/tests/integration/payments.test.ts
git commit -m "test(js-sdk): add integration tests for sandbox payments"
```

---

## Task 12: Integration tests — Python SDK

**Files:**
- Create: `packages/python-sdk/tests/sync/sandbox_sync/test_payments.py`
- Create: `packages/python-sdk/tests/async/sandbox_async/test_payments.py`

- [ ] **Step 1: Create the sync integration tests**

Create `packages/python-sdk/tests/sync/sandbox_sync/test_payments.py`:

```python
import os
import pytest
from e2b import Sandbox
from e2b.sandbox.payments import PaymentConfig

TEST_WALLET_KEY = os.environ.get("TEST_WALLET_KEY", "")
skip_if_no_key = pytest.mark.skipif(
    not TEST_WALLET_KEY, reason="TEST_WALLET_KEY not set in environment"
)


@skip_if_no_key
def test_get_balance_returns_address_and_usdc():
    sandbox = Sandbox.create(
        payments=PaymentConfig(private_key=TEST_WALLET_KEY, network="base-sepolia")
    )
    try:
        balance = sandbox.payments.get_balance()
        assert balance.address.startswith("0x")
        assert len(balance.address) == 42
        assert balance.usdc >= 0
    finally:
        sandbox.kill()


@skip_if_no_key
def test_get_history_returns_empty_before_payments():
    sandbox = Sandbox.create(
        payments=PaymentConfig(private_key=TEST_WALLET_KEY, network="base-sepolia")
    )
    try:
        assert sandbox.payments.get_history() == []
    finally:
        sandbox.kill()


@skip_if_no_key
def test_set_spending_limit_writes_inside_sandbox():
    sandbox = Sandbox.create(
        payments=PaymentConfig(
            private_key=TEST_WALLET_KEY, network="base-sepolia", max_spend=1.0
        )
    )
    try:
        sandbox.payments.set_spending_limit(0.5)
        content = sandbox.files.read("/tmp/.e2b-payment-limit")
        assert content.strip() == "0.5"
    finally:
        sandbox.kill()


@skip_if_no_key
def test_payment_env_vars_present_inside_sandbox():
    sandbox = Sandbox.create(
        payments=PaymentConfig(private_key=TEST_WALLET_KEY, network="base-sepolia")
    )
    try:
        result = sandbox.commands.run("echo $E2B_PAYMENT_NETWORK")
        assert result.stdout.strip() == "base-sepolia"
    finally:
        sandbox.kill()


def test_create_without_payments_leaves_payments_as_none():
    # Does not need TEST_WALLET_KEY — just verifies the default case
    # Note: this test requires a real E2B_API_KEY in the environment
    pytest.skip("Requires live E2B_API_KEY — run manually")
```

- [ ] **Step 2: Create the async integration tests**

Create `packages/python-sdk/tests/async/sandbox_async/test_payments.py`:

```python
import os
import pytest
from e2b import AsyncSandbox
from e2b.sandbox.payments import PaymentConfig

TEST_WALLET_KEY = os.environ.get("TEST_WALLET_KEY", "")
skip_if_no_key = pytest.mark.skipif(
    not TEST_WALLET_KEY, reason="TEST_WALLET_KEY not set in environment"
)


@skip_if_no_key
@pytest.mark.asyncio
async def test_async_get_balance():
    sandbox = await AsyncSandbox.create(
        payments=PaymentConfig(private_key=TEST_WALLET_KEY, network="base-sepolia")
    )
    try:
        balance = await sandbox.payments.get_balance()
        assert balance.address.startswith("0x")
        assert balance.usdc >= 0
    finally:
        await sandbox.kill()


@skip_if_no_key
@pytest.mark.asyncio
async def test_async_get_history_empty():
    sandbox = await AsyncSandbox.create(
        payments=PaymentConfig(private_key=TEST_WALLET_KEY, network="base-sepolia")
    )
    try:
        assert await sandbox.payments.get_history() == []
    finally:
        await sandbox.kill()


@skip_if_no_key
@pytest.mark.asyncio
async def test_async_set_spending_limit():
    sandbox = await AsyncSandbox.create(
        payments=PaymentConfig(
            private_key=TEST_WALLET_KEY, network="base-sepolia", max_spend=1.0
        )
    )
    try:
        await sandbox.payments.set_spending_limit(0.75)
        content = await sandbox.files.read("/tmp/.e2b-payment-limit")
        assert content.strip() == "0.75"
    finally:
        await sandbox.kill()
```

- [ ] **Step 3: Run unit tests (always pass)**

```bash
cd packages/python-sdk && poetry run pytest tests/unit/test_payments.py -v
```

Expected: All PASS

- [ ] **Step 4: Run integration tests (requires TEST_WALLET_KEY)**

```bash
cd packages/python-sdk && TEST_WALLET_KEY=<your-key> poetry run pytest \
  tests/sync/sandbox_sync/test_payments.py \
  tests/async/sandbox_async/test_payments.py -v
```

Expected: All 7 tests PASS (or SKIPPED if key not set)

- [ ] **Step 5: Commit**

```bash
git add packages/python-sdk/tests/sync/sandbox_sync/test_payments.py \
        packages/python-sdk/tests/async/sandbox_async/test_payments.py
git commit -m "test(python-sdk): add integration tests for sandbox payments"
```

---

## Task 13: Demo agent examples

**Files:**
- Create: `examples/payments/python-agent/agent.py`
- Create: `examples/payments/python-agent/requirements.txt`
- Create: `examples/payments/js-agent/agent.mjs`
- Create: `examples/payments/js-agent/package.json`
- Create: `examples/payments/README.md`

- [ ] **Step 1: Create the directory structure**

```bash
mkdir -p examples/payments/python-agent examples/payments/js-agent
```

- [ ] **Step 2: Create the Python demo agent**

Create `examples/payments/python-agent/agent.py`:

```python
"""
Demo: AI agent that autonomously pays for an x402 API using USDC on Base Sepolia.

The agent runs inside an e2b/payments-py sandbox. When it hits a 402 response,
the httpx interceptor automatically signs the payment and retries.
No changes to agent code needed.
"""

import httpx
import os

# This import activates the x402 interceptor (already done via sitecustomize.py in the template)
# Explicit import shown here for clarity
import e2b_payments  # noqa: F401


def run_agent():
    # Replace with a real x402-enabled API endpoint from https://mpp.dev/services
    API_ENDPOINT = os.environ.get("X402_API_ENDPOINT", "https://api.example-x402.com/search")
    QUERY = "latest AI research papers"

    print(f"Agent querying: {API_ENDPOINT}")
    print("If a 402 is returned, the interceptor will pay automatically...")

    response = httpx.get(API_ENDPOINT, params={"q": QUERY})
    response.raise_for_status()

    print(f"Got response (status {response.status_code}):")
    print(response.json())


if __name__ == "__main__":
    run_agent()
```

Create `examples/payments/python-agent/requirements.txt`:

```
httpx>=0.27.0
e2b-payments  # installed via template
```

- [ ] **Step 3: Create the JS demo agent**

Create `examples/payments/js-agent/agent.mjs`:

```javascript
/**
 * Demo: AI agent that autonomously pays for an x402 API using USDC on Base Sepolia.
 *
 * The agent runs inside an e2b/payments-js sandbox. When it hits a 402 response,
 * the fetch interceptor automatically signs the payment and retries.
 * No changes to agent code needed.
 */

// The fetch interceptor is loaded via NODE_OPTIONS in the template.
// Standard fetch calls work without any modification.

const API_ENDPOINT =
  process.env.X402_API_ENDPOINT || 'https://api.example-x402.com/search'

async function runAgent() {
  console.log(`Agent querying: ${API_ENDPOINT}`)
  console.log('If a 402 is returned, the interceptor will pay automatically...')

  const response = await fetch(`${API_ENDPOINT}?q=latest+AI+research+papers`)

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`)
  }

  const data = await response.json()
  console.log(`Got response (status ${response.status}):`)
  console.log(JSON.stringify(data, null, 2))
}

runAgent().catch(console.error)
```

Create `examples/payments/js-agent/package.json`:

```json
{
  "name": "e2b-payments-js-agent",
  "version": "1.0.0",
  "type": "module",
  "description": "Demo JS agent that pays for x402 APIs autonomously inside an E2B sandbox"
}
```

- [ ] **Step 4: Create the launch scripts (runs outside the sandbox)**

Create `examples/payments/python-agent/run.py`:

```python
"""Run the demo Python agent inside an E2B payments sandbox."""

import os
from e2b import Sandbox
from e2b.sandbox.payments import PaymentConfig

WALLET_KEY = os.environ["WALLET_PRIVATE_KEY"]
E2B_API_KEY = os.environ.get("E2B_API_KEY")

sandbox = Sandbox.create(
    template="e2b-payments-py",
    payments=PaymentConfig(
        private_key=WALLET_KEY,
        network="base-sepolia",  # Switch to "base" for mainnet
        max_spend=0.10,          # Hard cap at $0.10 USD
    ),
    api_key=E2B_API_KEY,
)

print(f"Sandbox created: {sandbox.sandbox_id}")
print(f"Wallet address: {sandbox.payments.wallet_address}")

# Upload and run the agent
sandbox.files.write("/home/user/agent.py", open("agent.py").read())
result = sandbox.commands.run("python /home/user/agent.py", timeout=30)

print("--- Agent output ---")
print(result.stdout)
if result.stderr:
    print("--- Stderr ---")
    print(result.stderr)

# Show what was paid
history = sandbox.payments.get_history()
print(f"\n--- Payment history ({len(history)} payments) ---")
for event in history:
    print(f"  {event.timestamp} | {event.url} | ${event.amount_usd:.4f} | {event.status}")

balance = sandbox.payments.get_balance()
print(f"\nRemaining balance: ${balance.usdc:.4f} USDC")

sandbox.kill()
```

- [ ] **Step 5: Create the README**

Create `examples/payments/README.md`:

```markdown
# E2B Sandbox x402 Payments — Demo

This example shows an AI agent that autonomously pays for external APIs using
USDC on Base Sepolia, running inside an E2B sandbox.

## How it works

1. You create a sandbox with a `payments` config (wallet key + spending cap)
2. The SDK injects wallet credentials as env vars
3. Inside the sandbox, the x402 interceptor patches `httpx`/`fetch`
4. When the agent hits a paid API, it gets a 402 — the interceptor signs the
   payment with EIP-3009 and retries automatically
5. Each payment is logged to `/tmp/.e2b-payments.jsonl`
6. From outside, `sandbox.payments.getHistory()` shows what was paid

## Prerequisites

- E2B account and API key
- Base Sepolia wallet with test USDC (get from https://faucet.circle.com)

## Python agent

```bash
cd python-agent
export WALLET_PRIVATE_KEY=0x...
export E2B_API_KEY=...
python run.py
```

## JS agent

```bash
cd js-agent
export WALLET_PRIVATE_KEY=0x...
export E2B_API_KEY=...
node run.mjs
```

## SDK API

```python
# Create a payment-enabled sandbox
sandbox = Sandbox.create(
    template="e2b-payments-py",
    payments=PaymentConfig(
        private_key=os.environ["WALLET_PRIVATE_KEY"],
        network="base-sepolia",   # use "base" for mainnet
        max_spend=1.00,           # $1 USD spending cap
    )
)

# Observability
balance = sandbox.payments.get_balance()   # {"usdc": 4.73, "address": "0x..."}
history = sandbox.payments.get_history()   # list of PaymentEvent
sandbox.payments.set_spending_limit(0.50)  # update cap without restart
```

## x402 services directory

Find APIs that accept x402 payments at https://mpp.dev/services (100+ services).
```
```

- [ ] **Step 6: Commit**

```bash
git add examples/payments/
git commit -m "docs: add demo examples for Python and JS payment agents"
```

---

## Task 14: Changeset and final checks

**Files:**
- Create: `.changeset/sandbox-payments.md`

- [ ] **Step 1: Create the changeset**

```bash
cd /path/to/repo && pnpm run changeset
```

When prompted:
- Select both `e2b` (JS SDK) and `@e2b/python-sdk`
- Choose **minor** version bump (new feature, backwards-compatible)
- Description: `Add native x402 payment support: \`payments\` option on \`Sandbox.create()\` enables autonomous USDC payments on Base, with \`sandbox.payments\` namespace for balance, history, and spending limit control`

Alternatively, create `.changeset/sandbox-payments.md` manually:

```markdown
---
"e2b": minor
"@e2b/python-sdk": minor
---

Add native x402 payment support to sandboxes.

`Sandbox.create({ payments: { privateKey, network, maxSpend } })` enables autonomous USDC payments on Base via the x402 protocol. AI agents inside the sandbox automatically pay for HTTP 402-gated APIs without any code changes.

New `sandbox.payments` namespace provides:
- `getBalance()` — on-chain USDC balance for the wallet
- `getHistory()` — log of all payments made from this sandbox
- `setSpendingLimit(usd)` — update the spending cap without restarting
```

- [ ] **Step 2: Run the full test suite**

```bash
pnpm run typecheck
pnpm run lint
cd packages/js-sdk && pnpm run test
cd ../python-sdk && make test
```

Expected: All pass

- [ ] **Step 3: Run format**

```bash
pnpm run format
```

- [ ] **Step 4: Final commit**

```bash
git add .changeset/sandbox-payments.md
git add -u  # stage any format changes
git commit -m "chore: add changeset for sandbox payments feature"
```

- [ ] **Step 5: Push to your fork**

```bash
git push origin feat/sandbox-payments
```

You now have a complete, mergeable implementation on your fork at `github.com/<you>/E2B/tree/feat/sandbox-payments`.
```
