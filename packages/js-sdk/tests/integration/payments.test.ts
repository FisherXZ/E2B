import { describe, it, expect } from 'vitest'
import { Sandbox } from '../../src/sandbox'
import { readFileSync } from 'fs'
import { resolve } from 'path'

// The integration vitest workspace project does not load dotenv automatically.
// Parse .env.local from the repo root and inject any missing env vars so that
// both E2B_API_KEY and TEST_WALLET_KEY are available when running this suite.
function loadEnvLocal(): void {
  try {
    const envFile = readFileSync(
      resolve(__dirname, '../../../../.env.local'),
      'utf8'
    )
    for (const line of envFile.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const eqIdx = trimmed.indexOf('=')
      if (eqIdx === -1) continue
      const key = trimmed.slice(0, eqIdx).trim()
      const value = trimmed.slice(eqIdx + 1).trim()
      // Only set if not already defined in the process environment
      if (!(key in process.env)) {
        process.env[key] = value
      }
    }
  } catch {
    // .env.local may not exist; rely entirely on process.env
  }
}

loadEnvLocal()

function getTestWalletKey(): string {
  return process.env.TEST_WALLET_KEY ?? ''
}

const TEST_WALLET_KEY = getTestWalletKey()
const SKIP = !TEST_WALLET_KEY

describe.skipIf(SKIP)(
  'Sandbox payments integration',
  { timeout: 60_000 },
  () => {
    it('getBalance returns address and usdc for a configured wallet', async () => {
      const sandbox = await Sandbox.create('base', {
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
      const sandbox = await Sandbox.create('base', {
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
      const sandbox = await Sandbox.create('base', {
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
      const sandbox = await Sandbox.create('base', {
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
          'test -n "$E2B_PAYMENT_PRIVATE_KEY" && echo key_present'
        )
        expect(keyResult.stdout.trim()).toBe('key_present')
      } finally {
        await sandbox.kill()
      }
    })
  }
)
