"""Launch the demo Python agent inside an E2B payments sandbox."""

import os
import sys
from pathlib import Path

from e2b import Sandbox, PaymentConfig


def main() -> None:
    wallet_key = os.environ.get("WALLET_PRIVATE_KEY")
    if not wallet_key:
        sys.exit("Set WALLET_PRIVATE_KEY (Base Sepolia testnet wallet)")

    x402_url = os.environ.get("X402_API_ENDPOINT")
    if not x402_url:
        sys.exit(
            "Set X402_API_ENDPOINT to a base-sepolia x402 service "
            "(see https://mpp.dev/services)"
        )

    sandbox = Sandbox.create(
        payments=PaymentConfig(
            private_key=wallet_key,
            network="base-sepolia",
            max_spend=0.10,  # cap at $0.10 USDC
        ),
        envs={"X402_API_ENDPOINT": x402_url},
    )
    print(f"Sandbox: {sandbox.sandbox_id}")
    print(f"Wallet:  {sandbox.payments.wallet_address}")

    agent_src = Path(__file__).parent / "agent.py"
    sandbox.files.write("/home/user/agent.py", agent_src.read_text())
    result = sandbox.commands.run("python /home/user/agent.py", timeout=60)

    print("\n--- Agent output ---")
    print(result.stdout)
    if result.stderr:
        print("--- Stderr ---")
        print(result.stderr)

    history = sandbox.payments.get_history()
    print(f"\n--- Payments ({len(history)}) ---")
    for event in history:
        print(
            f"  {event.timestamp} | {event.url} | "
            f"${event.amount_usd:.4f} | {event.status}"
        )

    balance = sandbox.payments.get_balance()
    print(f"\nRemaining: ${balance.usdc:.4f} USDC at {balance.address}")

    sandbox.kill()


if __name__ == "__main__":
    main()
