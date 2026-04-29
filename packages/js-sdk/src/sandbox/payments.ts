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
    let content: string
    try {
      content = await this.fs.read('/tmp/.e2b-payments.jsonl')
    } catch {
      // File does not exist yet — no payments have happened
      return []
    }
    return content
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as PaymentEvent)
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
    // USDC has 6 decimal places (not 18 like most ERC-20 tokens)
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
