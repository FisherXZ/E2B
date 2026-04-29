import pytest
from e2b.sandbox.payments import (
    PaymentConfig,
    PaymentEvent,
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
