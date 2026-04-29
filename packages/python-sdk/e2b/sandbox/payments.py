import json
import re
from dataclasses import dataclass
from typing import Dict, List, Literal, Optional


_PRIVATE_KEY_RE = re.compile(r"^0x[0-9a-fA-F]{64}$")
_KNOWN_NETWORKS = ("base", "base-sepolia")


@dataclass
class PaymentConfig:
    private_key: str
    network: Literal["base", "base-sepolia"] = "base-sepolia"
    max_spend: Optional[float] = None

    def __post_init__(self) -> None:
        if not _PRIVATE_KEY_RE.match(self.private_key):
            raise ValueError(
                "private_key must be a 0x-prefixed 32-byte hex string (64 hex chars after 0x)"
            )
        if self.network not in _KNOWN_NETWORKS:
            raise ValueError(
                f'network must be "base" or "base-sepolia", got "{self.network}"'
            )
        if self.max_spend is not None and self.max_spend < 0:
            raise ValueError("max_spend must be non-negative")


@dataclass
class PaymentEvent:
    timestamp: str
    url: str
    amount_usd: float
    tx_hash: str
    status: Literal["success", "failed"]


@dataclass
class SandboxPaymentsBalance:
    usdc: float
    address: str


def build_payment_envs(config: PaymentConfig) -> Dict[str, str]:
    envs: Dict[str, str] = {
        "E2B_PAYMENT_PRIVATE_KEY": config.private_key,
        "E2B_PAYMENT_NETWORK": config.network,
    }
    if config.max_spend is not None:
        envs["E2B_PAYMENT_MAX_SPEND"] = str(config.max_spend)
    return envs


_RPC_URLS = {
    "base": "https://mainnet.base.org",
    "base-sepolia": "https://sepolia.base.org",
}

_USDC_ADDRESSES = {
    "base": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    "base-sepolia": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
}


class SandboxPayments:
    def __init__(self, config: PaymentConfig, filesystem) -> None:
        from eth_account import Account

        self.wallet_address: str = Account.from_key(config.private_key).address
        self._network = config.network
        self._fs = filesystem

    def get_history(self) -> List[PaymentEvent]:
        try:
            content = self._fs.read("/tmp/.e2b-payments.jsonl")
            lines = [line for line in content.split("\n") if line.strip()]
            return [PaymentEvent(**json.loads(line)) for line in lines]
        except Exception:
            return []

    def get_balance(self) -> SandboxPaymentsBalance:
        import httpx

        rpc_url = _RPC_URLS[self._network]
        usdc_address = _USDC_ADDRESSES[self._network]
        # ABI-encode balanceOf(address): selector + 32-byte padded address
        data = "0x70a08231" + self.wallet_address[2:].lower().zfill(64)
        resp = httpx.post(
            rpc_url,
            json={
                "jsonrpc": "2.0",
                "method": "eth_call",
                "params": [{"to": usdc_address, "data": data}, "latest"],
                "id": 1,
            },
        )
        result = resp.json()["result"]
        # USDC has 6 decimal places (not 18 like most ERC-20 tokens)
        usdc = int(result, 16) / 1e6
        return SandboxPaymentsBalance(usdc=usdc, address=self.wallet_address)

    def set_spending_limit(self, usd: float) -> None:
        if usd < 0:
            raise ValueError("Spending limit must be non-negative")
        self._fs.write("/tmp/.e2b-payment-limit", str(usd))


class AsyncSandboxPayments:
    def __init__(self, config: PaymentConfig, filesystem) -> None:
        from eth_account import Account

        self.wallet_address: str = Account.from_key(config.private_key).address
        self._network = config.network
        self._fs = filesystem

    async def get_history(self) -> List[PaymentEvent]:
        try:
            content = await self._fs.read("/tmp/.e2b-payments.jsonl")
            lines = [line for line in content.split("\n") if line.strip()]
            return [PaymentEvent(**json.loads(line)) for line in lines]
        except Exception:
            return []

    async def get_balance(self) -> SandboxPaymentsBalance:
        import httpx

        rpc_url = _RPC_URLS[self._network]
        usdc_address = _USDC_ADDRESSES[self._network]
        data = "0x70a08231" + self.wallet_address[2:].lower().zfill(64)
        async with httpx.AsyncClient() as client:
            resp = await client.post(
                rpc_url,
                json={
                    "jsonrpc": "2.0",
                    "method": "eth_call",
                    "params": [{"to": usdc_address, "data": data}, "latest"],
                    "id": 1,
                },
            )
        result = resp.json()["result"]
        # USDC has 6 decimal places (not 18 like most ERC-20 tokens)
        usdc = int(result, 16) / 1e6
        return SandboxPaymentsBalance(usdc=usdc, address=self.wallet_address)

    async def set_spending_limit(self, usd: float) -> None:
        if usd < 0:
            raise ValueError("Spending limit must be non-negative")
        await self._fs.write("/tmp/.e2b-payment-limit", str(usd))
