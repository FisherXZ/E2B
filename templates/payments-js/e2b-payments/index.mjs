/**
 * E2B x402 payment interceptor for Node.js.
 * Wraps global fetch to auto-handle HTTP 402 responses using EIP-3009 USDC transfers.
 * Auto-activates when E2B_PAYMENT_PRIVATE_KEY is set.
 */

import { appendFileSync, existsSync, readFileSync } from 'fs'
import { privateKeyToAccount } from 'viem/accounts'
import { toHex } from 'viem'

const PRIVATE_KEY = process.env.E2B_PAYMENT_PRIVATE_KEY
const NETWORK = process.env.E2B_PAYMENT_NETWORK || 'base-sepolia'
const PAYMENTS_LOG = '/tmp/.e2b-payments.jsonl'
const SPEND_LIMIT_FILE = '/tmp/.e2b-payment-limit'
// USDC EIP-712 domain version. Set E2B_PAYMENT_USDC_VERSION env var if Coinbase
// upgrades the contract implementation (e.g. "2" → "2.2" as happened on Ethereum).
const USDC_VERSION = process.env.E2B_PAYMENT_USDC_VERSION || '2'

const CHAIN_IDS = { base: 8453, 'base-sepolia': 84532 }

if (!PRIVATE_KEY) {
  // Module imported but no credentials — exit early without patching fetch.
  // Using a no-op return rather than process.exit so other top-level code can run.
} else {
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
}
