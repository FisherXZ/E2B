import os
import pytest
from e2b import AsyncSandbox, PaymentConfig

TEST_WALLET_KEY = os.environ.get("TEST_WALLET_KEY", "")
skip_if_no_key = pytest.mark.skipif(
    not TEST_WALLET_KEY, reason="TEST_WALLET_KEY not set in environment"
)


@skip_if_no_key
async def test_async_get_balance():
    sandbox = await AsyncSandbox.create(
        template="base",
        payments=PaymentConfig(private_key=TEST_WALLET_KEY, network="base-sepolia"),
    )
    try:
        balance = await sandbox.payments.get_balance()
        assert balance.address.startswith("0x")
        assert balance.usdc >= 0
    finally:
        await sandbox.kill()


@skip_if_no_key
async def test_async_get_history_empty():
    sandbox = await AsyncSandbox.create(
        template="base",
        payments=PaymentConfig(private_key=TEST_WALLET_KEY, network="base-sepolia"),
    )
    try:
        assert await sandbox.payments.get_history() == []
    finally:
        await sandbox.kill()


@skip_if_no_key
async def test_async_set_spending_limit():
    sandbox = await AsyncSandbox.create(
        template="base",
        payments=PaymentConfig(
            private_key=TEST_WALLET_KEY, network="base-sepolia", max_spend=1.0
        ),
    )
    try:
        await sandbox.payments.set_spending_limit(0.75)
        content = await sandbox.files.read("/tmp/.e2b-payment-limit")
        assert content.strip() == "0.75"
    finally:
        await sandbox.kill()
