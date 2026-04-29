/** Launch the demo JS agent inside an E2B payments sandbox. */

import { readFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { Sandbox } from 'e2b'

const __dirname = dirname(fileURLToPath(import.meta.url))

const walletKey = process.env.WALLET_PRIVATE_KEY
if (!walletKey) {
  console.error('Set WALLET_PRIVATE_KEY (Base Sepolia testnet wallet)')
  process.exit(1)
}

const x402Url = process.env.X402_API_ENDPOINT
if (!x402Url) {
  console.error(
    'Set X402_API_ENDPOINT to a base-sepolia x402 service ' +
      '(see https://mpp.dev/services)'
  )
  process.exit(1)
}

const sandbox = await Sandbox.create({
  payments: {
    privateKey: walletKey,
    network: 'base-sepolia',
    maxSpend: 0.1,
  },
  envs: { X402_API_ENDPOINT: x402Url },
})

console.log(`Sandbox: ${sandbox.sandboxId}`)
console.log(`Wallet:  ${sandbox.payments.walletAddress}`)

const agentSrc = readFileSync(resolve(__dirname, 'agent.mjs'), 'utf8')
await sandbox.files.write('/home/user/agent.mjs', agentSrc)

const result = await sandbox.commands.run('node /home/user/agent.mjs', {
  timeoutMs: 60_000,
})

console.log('\n--- Agent output ---')
console.log(result.stdout)
if (result.stderr) {
  console.log('--- Stderr ---')
  console.log(result.stderr)
}

const history = await sandbox.payments.getHistory()
console.log(`\n--- Payments (${history.length}) ---`)
for (const event of history) {
  console.log(
    `  ${event.timestamp} | ${event.url} | ` +
      `$${event.amountUsd.toFixed(4)} | ${event.status}`
  )
}

const balance = await sandbox.payments.getBalance()
console.log(
  `\nRemaining: $${balance.usdc.toFixed(4)} USDC at ${balance.address}`
)

await sandbox.kill()
