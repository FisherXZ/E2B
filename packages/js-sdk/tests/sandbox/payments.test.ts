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
