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
// CAIP-2 aliases — x402 v2 servers use this format ("eip155:84532") instead of
// the human-friendly name. Match accepts[] entries regardless of which form the server emits.
const NETWORK_ALIASES = {
  base: new Set(['base', 'eip155:8453']),
  'base-sepolia': new Set(['base-sepolia', 'eip155:84532']),
}

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
          if (event.status === 'success') spent += event.amount_usd ?? event.amountUsd ?? 0
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
    // Field names match the Python PaymentEvent dataclass (snake_case) so get_history() parses both.
    const event = JSON.stringify({ timestamp: new Date().toISOString(), url, amount_usd: amountUsd, tx_hash: txHash, status })
    appendFileSync(PAYMENTS_LOG, event + '\n')
  }

  function decodeHeader(headerValue) {
    if (!headerValue) return null
    try {
      return JSON.parse(Buffer.from(headerValue, 'base64').toString('utf8'))
    } catch {
      return null
    }
  }

  function selectAccept(envelope) {
    if (!envelope || typeof envelope !== 'object') return null
    const accepts = envelope.accepts
    if (Array.isArray(accepts) && accepts.length) {
      const wanted = NETWORK_ALIASES[NETWORK] || new Set([NETWORK])
      for (const entry of accepts) {
        if (entry && typeof entry === 'object'
            && wanted.has(entry.network)
            && (entry.scheme || 'exact') === 'exact') return entry
      }
      for (const entry of accepts) {
        if (entry && typeof entry === 'object' && (entry.scheme || 'exact') === 'exact') return entry
      }
      return typeof accepts[0] === 'object' ? accepts[0] : null
    }
    // Legacy v1 flat shape
    if (envelope.asset || envelope.usdcAddress) return envelope
    return null
  }

  async function extractRequirements(response) {
    // x402 v2 puts requirements in the `payment-required` HTTP header (base64 JSON).
    // Some servers also (or only) send them in the response body — try header first.
    const headerVal = response.headers.get('payment-required')
    let envelope = headerVal ? decodeHeader(headerVal) : null
    if (!envelope) {
      try {
        envelope = await response.clone().json()
      } catch {
        return { entry: null, responseNetwork: null, resource: null }
      }
    }
    const entry = selectAccept(envelope)
    if (!entry) return { entry: null, responseNetwork: null, resource: null }
    const resource = envelope.resource || null
    return { entry, responseNetwork: entry.network || NETWORK, resource }
  }

  async function buildPaymentHeader(entry, responseNetwork, resource) {
    const usdcAddress = entry.asset || entry.usdcAddress
    const payTo = entry.payTo || entry.payToAddress
    if (!usdcAddress || !payTo) {
      throw new Error('Payment requirements missing asset/payTo')
    }
    // x402 v2 servers use "amount"; v1 servers use "maxAmountRequired"
    const rawAmount = 'maxAmountRequired' in entry ? entry.maxAmountRequired : entry.amount
    if (rawAmount == null) throw new Error('Payment requirements missing amount/maxAmountRequired')
    const amount = BigInt(rawAmount)
    const timeoutSeconds = Number(entry.maxTimeoutSeconds ?? entry.requiredDeadlineSeconds ?? 300)
    const deadline = BigInt(Math.floor(Date.now() / 1000) + timeoutSeconds)
    // toHex() produces a 0x-prefixed hex string — the correct Hex type for viem's bytes32
    const nonce = toHex(crypto.getRandomValues(new Uint8Array(32)))
    const chainId = CHAIN_IDS[NETWORK] || 84532

    // Use EIP-712 domain name from server's extra.name (verified against on-chain
    // DOMAIN_SEPARATOR). Base Sepolia USDC uses "USDC", not "USD Coin".
    const domainName = entry.extra?.name || 'USDC'
    const domain = {
      name: domainName,
      version: entry.extra?.version || USDC_VERSION,
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

    // x402 v2: { accepted, payload } envelope sent in PAYMENT-SIGNATURE header.
    const outer = {
      x402Version: 2,
      accepted: entry,
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
    if (resource) outer.resource = resource
    return Buffer.from(JSON.stringify(outer)).toString('base64')
  }

  // Patch global fetch — runs synchronously at module load time so the patch is
  // guaranteed to be in place before any user code executes (safe with --import).
  const _originalFetch = globalThis.fetch
  globalThis.fetch = async function patchedFetch(input, init) {
    const response = await _originalFetch(input, init)
    if (response.status !== 402) return response

    const { entry, responseNetwork, resource } = await extractRequirements(response)
    if (!entry) return response

    // x402 v2 uses "amount"; v1 uses "maxAmountRequired". USDC has 6 decimal places.
    const rawAmount = 'maxAmountRequired' in entry ? entry.maxAmountRequired : (entry.amount || '0')
    const amountUsd = Number(BigInt(rawAmount)) / 1e6

    return withPaymentLock(async () => {
      checkSpendingLimit(amountUsd)
      const paymentHeader = await buildPaymentHeader(entry, responseNetwork, resource)
      const retryInit = {
        ...(init || {}),
        // x402 v2 uses PAYMENT-SIGNATURE header; v1 used X-PAYMENT
        headers: { ...(init?.headers || {}), 'PAYMENT-SIGNATURE': paymentHeader },
      }
      const retryResponse = await _originalFetch(input, retryInit)
      // x402 v2 uses PAYMENT-RESPONSE header; v1 used X-PAYMENT-RESPONSE
      const txHash = retryResponse.headers.get('PAYMENT-RESPONSE')
        || retryResponse.headers.get('X-PAYMENT-RESPONSE')
        || 'unknown'
      const status = retryResponse.status !== 402 ? 'success' : 'failed'
      logPayment(typeof input === 'string' ? input : input.url, amountUsd, txHash, status)
      return retryResponse
    })
  }
}
