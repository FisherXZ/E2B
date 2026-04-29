/**
 * Demo: AI agent that autonomously pays for an x402 API using USDC on Base Sepolia.
 *
 * Runs inside an e2b/payments-js sandbox. The fetch interceptor (loaded via
 * NODE_OPTIONS=--import) handles 402 responses by signing EIP-3009 transfers.
 * Standard fetch() works transparently — no agent code changes needed.
 */

const apiEndpoint =
  process.env.X402_API_ENDPOINT || 'https://api.example-x402.com/search'

console.log(`Agent querying: ${apiEndpoint}`)
console.log('If a 402 is returned, the interceptor pays automatically...')

const response = await fetch(`${apiEndpoint}?q=latest+AI+research+papers`)
if (!response.ok) {
  throw new Error(`HTTP ${response.status}: ${response.statusText}`)
}

const data = await response.json()
console.log(`Got response (status ${response.status}):`)
console.log(JSON.stringify(data, null, 2))
