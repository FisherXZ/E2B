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
