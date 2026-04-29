/**
 * End-to-end smoke test for Sandbox.create({ payments: ... }).
 *
 * Mocks SandboxApi.createSandbox so this runs without credentials and exercises
 * the full create() code path: validation → env merge → constructor wiring →
 * SandboxPayments attachment.
 *
 * Run with: pnpm vitest run tests/sandbox/payments.smoke.test.ts
 */
import { afterEach, describe, it, expect, vi } from 'vitest'
import { Sandbox } from '../../src'
import { SandboxApi } from '../../src/sandbox/sandboxApi'
import { SandboxPayments } from '../../src/sandbox/payments'

const TEST_KEY =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
const EXPECTED_ADDRESS = '0xf39Fd6e51aad88F6f4ce6aB8827279cffFb92266'

const FAKE_SANDBOX_INFO = {
  sandboxId: 'sbx_smoke_test',
  sandboxDomain: 'sandbox.e2b.dev',
  envdVersion: '0.2.4',
  envdAccessToken: 'tok',
  trafficAccessToken: 'tok',
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('Sandbox.create({ payments }) — end-to-end smoke', () => {
  it('attaches a real SandboxPayments instance with the correct wallet address', async () => {
    const spy = vi
      .spyOn(SandboxApi as any, 'createSandbox')
      .mockResolvedValue(FAKE_SANDBOX_INFO)

    const sandbox = await Sandbox.create({
      apiKey: 'test-api-key',
      payments: {
        privateKey: TEST_KEY,
        network: 'base-sepolia',
        maxSpend: 5.0,
      },
    })

    expect(spy).toHaveBeenCalledTimes(1)
    expect(sandbox.payments).toBeInstanceOf(SandboxPayments)
    expect(sandbox.payments?.walletAddress.toLowerCase()).toBe(
      EXPECTED_ADDRESS.toLowerCase()
    )
  })

  it('merges payment env vars into the createSandbox call', async () => {
    const spy = vi
      .spyOn(SandboxApi as any, 'createSandbox')
      .mockResolvedValue(FAKE_SANDBOX_INFO)

    await Sandbox.create({
      apiKey: 'test-api-key',
      payments: {
        privateKey: TEST_KEY,
        network: 'base',
        maxSpend: 2.5,
      },
    })

    const opts = spy.mock.calls[0][2] as { envs?: Record<string, string> }
    expect(opts.envs?.E2B_PAYMENT_PRIVATE_KEY).toBe(TEST_KEY)
    expect(opts.envs?.E2B_PAYMENT_NETWORK).toBe('base')
    expect(opts.envs?.E2B_PAYMENT_MAX_SPEND).toBe('2.5')
  })

  it('preserves user-provided envs alongside payment envs', async () => {
    const spy = vi
      .spyOn(SandboxApi as any, 'createSandbox')
      .mockResolvedValue(FAKE_SANDBOX_INFO)

    await Sandbox.create({
      apiKey: 'test-api-key',
      envs: { MY_API_KEY: 'secret', OTHER: 'value' },
      payments: { privateKey: TEST_KEY },
    })

    const opts = spy.mock.calls[0][2] as { envs?: Record<string, string> }
    expect(opts.envs?.MY_API_KEY).toBe('secret')
    expect(opts.envs?.OTHER).toBe('value')
    expect(opts.envs?.E2B_PAYMENT_PRIVATE_KEY).toBe(TEST_KEY)
    expect(opts.envs?.E2B_PAYMENT_NETWORK).toBe('base-sepolia')
  })

  it('omits E2B_PAYMENT_MAX_SPEND from envs when maxSpend not provided', async () => {
    const spy = vi
      .spyOn(SandboxApi as any, 'createSandbox')
      .mockResolvedValue(FAKE_SANDBOX_INFO)

    await Sandbox.create({
      apiKey: 'test-api-key',
      payments: { privateKey: TEST_KEY },
    })

    const opts = spy.mock.calls[0][2] as { envs?: Record<string, string> }
    expect('E2B_PAYMENT_MAX_SPEND' in (opts.envs ?? {})).toBe(false)
  })

  it('does not attach payments when no payments option is given', async () => {
    vi.spyOn(SandboxApi as any, 'createSandbox').mockResolvedValue(
      FAKE_SANDBOX_INFO
    )

    const sandbox = await Sandbox.create({ apiKey: 'test-api-key' })

    expect(sandbox.payments).toBeUndefined()
  })

  it('rejects an invalid private key before calling the API', async () => {
    const spy = vi
      .spyOn(SandboxApi as any, 'createSandbox')
      .mockResolvedValue(FAKE_SANDBOX_INFO)

    await expect(
      Sandbox.create({
        apiKey: 'test-api-key',
        payments: { privateKey: 'not-a-valid-key' },
      })
    ).rejects.toThrow('0x-prefixed')

    // Validation should fail BEFORE any API call
    expect(spy).not.toHaveBeenCalled()
  })

  it('rejects an unknown network before calling the API', async () => {
    const spy = vi
      .spyOn(SandboxApi as any, 'createSandbox')
      .mockResolvedValue(FAKE_SANDBOX_INFO)

    await expect(
      Sandbox.create({
        apiKey: 'test-api-key',
        payments: {
          privateKey: TEST_KEY,
          network: 'ethereum' as 'base',
        },
      })
    ).rejects.toThrow('network must be')

    expect(spy).not.toHaveBeenCalled()
  })

  it('SandboxPayments uses the sandbox files API for getHistory', async () => {
    vi.spyOn(SandboxApi as any, 'createSandbox').mockResolvedValue(
      FAKE_SANDBOX_INFO
    )

    const sandbox = await Sandbox.create({
      apiKey: 'test-api-key',
      payments: { privateKey: TEST_KEY },
    })

    // Mock the underlying files.read so we can verify wiring
    const filesReadSpy = vi
      .spyOn(sandbox.files, 'read')
      .mockResolvedValue('' as never)

    const history = await sandbox.payments!.getHistory()

    expect(filesReadSpy).toHaveBeenCalledWith('/tmp/.e2b-payments.jsonl')
    expect(history).toEqual([])
  })
})
