import re
from dataclasses import dataclass
from typing import Dict, Literal, Optional


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
