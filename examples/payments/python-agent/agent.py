"""
Demo: AI agent that autonomously pays for an x402 API using USDC on Base Sepolia.

Runs inside an e2b/payments-py sandbox. The httpx interceptor (auto-loaded via
sitecustomize) handles 402 responses by signing EIP-3009 USDC transfers.
No changes to agent code needed — standard httpx works transparently.
"""

import os
import httpx


def run_agent() -> None:
    api_endpoint = os.environ.get(
        "X402_API_ENDPOINT", "https://api.example-x402.com/search"
    )
    query = "latest AI research papers"

    print(f"Agent querying: {api_endpoint}")
    print("If a 402 is returned, the interceptor pays automatically...")

    response = httpx.get(api_endpoint, params={"q": query})
    response.raise_for_status()

    print(f"Got response (status {response.status_code}):")
    try:
        print(response.json())
    except ValueError:
        print(response.text[:500])


if __name__ == "__main__":
    run_agent()
