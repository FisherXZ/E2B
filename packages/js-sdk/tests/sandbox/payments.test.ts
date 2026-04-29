import { describe, it, expect } from 'vitest'
import {
  validatePaymentConfig,
  buildPaymentEnvs,
} from '../../src/sandbox/payments'

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
      validatePaymentConfig({
        privateKey: VALID_KEY,
        network: 'ethereum' as any,
      })
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

import { SandboxPayments } from '../../src/sandbox/payments'

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

// A real 32-byte private key (Hardhat account #0 — public knowledge, never use in production)
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
    const sp = new SandboxPayments(
      { privateKey: TEST_KEY },
      makeFakeFilesystem()
    )
    expect(sp.walletAddress.toLowerCase()).toBe(
      '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266'
    )
  })
})
