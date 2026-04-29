import os
import pytest
from e2b import Sandbox, PaymentConfig

TEST_WALLET_KEY = os.environ.get("TEST_WALLET_KEY", "")
skip_if_no_key = pytest.mark.skipif(
    not TEST_WALLET_KEY, reason="TEST_WALLET_KEY not set in environment"
)


@skip_if_no_key
def test_get_balance_returns_address_and_usdc():
    sandbox = Sandbox.create(
        template="base",
        payments=PaymentConfig(private_key=TEST_WALLET_KEY, network="base-sepolia"),
    )
    try:
        balance = sandbox.payments.get_balance()
        assert balance.address.startswith("0x")
        assert len(balance.address) == 42
        assert balance.usdc >= 0
    finally:
        sandbox.kill()


@skip_if_no_key
def test_get_history_returns_empty_before_payments():
    sandbox = Sandbox.create(
        template="base",
        payments=PaymentConfig(private_key=TEST_WALLET_KEY, network="base-sepolia"),
    )
    try:
        assert sandbox.payments.get_history() == []
    finally:
        sandbox.kill()


@skip_if_no_key
def test_set_spending_limit_writes_inside_sandbox():
    sandbox = Sandbox.create(
        template="base",
        payments=PaymentConfig(
            private_key=TEST_WALLET_KEY, network="base-sepolia", max_spend=1.0
        ),
    )
    try:
        sandbox.payments.set_spending_limit(0.5)
        content = sandbox.files.read("/tmp/.e2b-payment-limit")
        assert content.strip() == "0.5"
    finally:
        sandbox.kill()


@skip_if_no_key
def test_payment_env_vars_present_inside_sandbox():
    sandbox = Sandbox.create(
        template="base",
        payments=PaymentConfig(private_key=TEST_WALLET_KEY, network="base-sepolia"),
    )
    try:
        result = sandbox.commands.run("echo $E2B_PAYMENT_NETWORK")
        assert result.stdout.strip() == "base-sepolia"
    finally:
        sandbox.kill()
