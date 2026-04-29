import json
from unittest.mock import MagicMock

import pytest

from e2b.sandbox.payments import (
    PaymentConfig,
    SandboxPayments,
    build_payment_envs,
)

VALID_KEY = "0x" + "a" * 64


class TestPaymentConfig:
    def test_accepts_valid_key(self):
        config = PaymentConfig(private_key=VALID_KEY)
        assert config.network == "base-sepolia"

    def test_rejects_key_without_prefix(self):
        with pytest.raises(ValueError, match="0x-prefixed"):
            PaymentConfig(private_key="a" * 64)

    def test_rejects_key_too_short(self):
        with pytest.raises(ValueError, match="0x-prefixed"):
            PaymentConfig(private_key="0x" + "a" * 63)

    def test_rejects_key_too_long(self):
        with pytest.raises(ValueError, match="0x-prefixed"):
            PaymentConfig(private_key="0x" + "a" * 65)

    def test_rejects_unknown_network(self):
        with pytest.raises(ValueError, match="network must be"):
            PaymentConfig(private_key=VALID_KEY, network="ethereum")

    def test_accepts_base_network(self):
        config = PaymentConfig(private_key=VALID_KEY, network="base")
        assert config.network == "base"

    def test_rejects_negative_max_spend(self):
        with pytest.raises(ValueError, match="non-negative"):
            PaymentConfig(private_key=VALID_KEY, max_spend=-0.01)

    def test_accepts_zero_max_spend(self):
        config = PaymentConfig(private_key=VALID_KEY, max_spend=0)
        assert config.max_spend == 0


class TestBuildPaymentEnvs:
    def test_includes_private_key(self):
        envs = build_payment_envs(PaymentConfig(private_key=VALID_KEY))
        assert envs["E2B_PAYMENT_PRIVATE_KEY"] == VALID_KEY

    def test_defaults_network_to_base_sepolia(self):
        envs = build_payment_envs(PaymentConfig(private_key=VALID_KEY))
        assert envs["E2B_PAYMENT_NETWORK"] == "base-sepolia"

    def test_uses_provided_network(self):
        envs = build_payment_envs(PaymentConfig(private_key=VALID_KEY, network="base"))
        assert envs["E2B_PAYMENT_NETWORK"] == "base"

    def test_omits_max_spend_when_not_set(self):
        envs = build_payment_envs(PaymentConfig(private_key=VALID_KEY))
        assert "E2B_PAYMENT_MAX_SPEND" not in envs

    def test_includes_max_spend_as_string(self):
        envs = build_payment_envs(PaymentConfig(private_key=VALID_KEY, max_spend=5.5))
        assert envs["E2B_PAYMENT_MAX_SPEND"] == "5.5"


# A real secp256k1 test private key (Hardhat account #0 — public knowledge, never use in prod)
TEST_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
EXPECTED_ADDRESS = "0xf39Fd6e51aad88F6f4ce6aB8827279cffFb92266"


def make_fake_filesystem(content: str = ""):
    fs = MagicMock()
    if content:
        fs.read.return_value = content
    else:
        fs.read.side_effect = Exception("not found")
    fs.write = MagicMock()
    return fs


class TestSandboxPaymentsGetHistory:
    def test_returns_empty_list_when_file_missing(self):
        fs = make_fake_filesystem()
        sp = SandboxPayments(PaymentConfig(private_key=TEST_KEY), fs)
        assert sp.get_history() == []

    def test_parses_jsonl_lines(self):
        event = {
            "timestamp": "2026-04-28T00:00:00Z",
            "url": "https://api.example.com/data",
            "amount_usd": 0.001,
            "tx_hash": "0xabc",
            "status": "success",
        }
        fs = make_fake_filesystem(json.dumps(event) + "\n")
        sp = SandboxPayments(PaymentConfig(private_key=TEST_KEY), fs)
        history = sp.get_history()
        assert len(history) == 1
        assert history[0].status == "success"
        assert history[0].amount_usd == 0.001

    def test_skips_empty_lines(self):
        event = {
            "timestamp": "t",
            "url": "u",
            "amount_usd": 0.001,
            "tx_hash": "h",
            "status": "success",
        }
        fs = make_fake_filesystem("\n" + json.dumps(event) + "\n\n")
        sp = SandboxPayments(PaymentConfig(private_key=TEST_KEY), fs)
        assert len(sp.get_history()) == 1


class TestSandboxPaymentsSetSpendingLimit:
    def test_writes_limit_to_correct_path(self):
        fs = make_fake_filesystem()
        sp = SandboxPayments(PaymentConfig(private_key=TEST_KEY), fs)
        sp.set_spending_limit(2.5)
        fs.write.assert_called_once_with("/tmp/.e2b-payment-limit", "2.5")

    def test_raises_for_negative_limit(self):
        fs = make_fake_filesystem()
        sp = SandboxPayments(PaymentConfig(private_key=TEST_KEY), fs)
        with pytest.raises(ValueError, match="non-negative"):
            sp.set_spending_limit(-1)


class TestSandboxPaymentsWalletAddress:
    def test_derives_correct_address_from_key(self):
        sp = SandboxPayments(PaymentConfig(private_key=TEST_KEY), MagicMock())
        assert sp.wallet_address.lower() == EXPECTED_ADDRESS.lower()
