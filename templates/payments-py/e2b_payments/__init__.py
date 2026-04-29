"""
E2B x402 payment interceptor.
Auto-activates when E2B_PAYMENT_PRIVATE_KEY is set.
Wraps httpx.Client and httpx.AsyncClient to handle HTTP 402 responses automatically.
"""

import base64
import fcntl
import json
import os
import threading
import time
from pathlib import Path
from typing import Optional

_PRIVATE_KEY = os.environ.get("E2B_PAYMENT_PRIVATE_KEY", "")
_NETWORK = os.environ.get("E2B_PAYMENT_NETWORK", "base-sepolia")
# USDC EIP-712 domain version. Override with E2B_PAYMENT_USDC_VERSION if Coinbase
# upgrades the contract implementation (as they did on Ethereum: "2" → "2.2").
# The correct way to eliminate this entirely is to call DOMAIN_SEPARATOR() on the
# contract at runtime and pass it directly — but that costs one extra RPC call.
_USDC_VERSION = os.environ.get("E2B_PAYMENT_USDC_VERSION", "2")
_PAYMENTS_LOG = Path("/tmp/.e2b-payments.jsonl")
_SPEND_LIMIT_FILE = Path("/tmp/.e2b-payment-limit")
_PAYMENT_LOCK = Path("/tmp/.e2b-payment-lock")

_CHAIN_IDS = {"base": 8453, "base-sepolia": 84532}

# Re-entrancy guard: prevents the interceptor firing on its own internal httpx calls.
_payment_in_progress = threading.local()

# E2B's own REST API must never be intercepted — it may legitimately return 402
# for quota enforcement, and patching those calls risks sending wallet funds to E2B.
_E2B_API_HOSTS = frozenset({"api.e2b.dev", "api.e2b.io"})


class SpendingLimitExceeded(Exception):
    pass


def _get_account():
    if not _PRIVATE_KEY:
        return None
    from eth_account import Account
    return Account.from_key(_PRIVATE_KEY)


def _check_and_log_payment(amount_usd: float, url: str, tx_hash: str, status: str) -> None:
    """Check spending limit and append log entry atomically under an exclusive file lock.

    Combining the check and write in one locked section eliminates the TOCTOU race
    where concurrent requests all read the same cumulative total and each pass the check.
    """
    _PAYMENT_LOCK.touch(exist_ok=True)
    with open(_PAYMENT_LOCK, "r") as lock_f:
        fcntl.flock(lock_f, fcntl.LOCK_EX)
        try:
            if _SPEND_LIMIT_FILE.exists():
                limit_str = _SPEND_LIMIT_FILE.read_text().strip()
                if limit_str:
                    limit = float(limit_str)
                    spent = 0.0
                    if _PAYMENTS_LOG.exists():
                        for line in _PAYMENTS_LOG.read_text().splitlines():
                            if line.strip():
                                try:
                                    event = json.loads(line)
                                    if event.get("status") == "success":
                                        # USDC has 6 decimal places, not 18
                                        spent += event.get("amount_usd", 0)
                                except json.JSONDecodeError:
                                    pass  # skip corrupt lines, don't block payments
                    if spent + amount_usd > limit:
                        raise SpendingLimitExceeded(
                            f"Payment of ${amount_usd:.4f} would exceed spending limit "
                            f"of ${limit:.4f} (spent so far: ${spent:.4f})"
                        )
            # Write while still holding the lock — atomic check-then-write
            event = {
                "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                "url": url,
                "amount_usd": amount_usd,
                "tx_hash": tx_hash,
                "status": status,
            }
            with _PAYMENTS_LOG.open("a") as f:
                f.write(json.dumps(event) + "\n")
        finally:
            fcntl.flock(lock_f, fcntl.LOCK_UN)


def _build_payment_header(payment_requirements: dict) -> str:
    """Build base64-encoded X-PAYMENT header using EIP-3009 TransferWithAuthorization."""
    from eth_account import Account
    import secrets as _secrets

    account = _get_account()
    if account is None:
        raise RuntimeError("E2B_PAYMENT_PRIVATE_KEY not set")

    usdc_address = payment_requirements["usdcAddress"]
    pay_to = payment_requirements["payToAddress"]
    amount = int(payment_requirements["maxAmountRequired"])
    deadline = int(time.time()) + int(payment_requirements.get("requiredDeadlineSeconds", 300))
    # bytes32 nonce: 32 cryptographically random bytes
    nonce = bytes.fromhex(_secrets.token_hex(32))

    chain_id = _CHAIN_IDS.get(_NETWORK, 84532)

    # eth-account >= 0.9.0 API: domain_data, message_types, and message_data are
    # separate positional arguments. EIP712Domain must NOT appear in message_types —
    # eth-account raises ValueError("EIP712Domain type is not allowed in message_types")
    # if it does. The full_message= kwarg form was removed in 0.9.0.
    domain_data = {
        "name": "USD Coin",
        "version": _USDC_VERSION,
        "chainId": chain_id,
        "verifyingContract": usdc_address,
    }
    message_types = {
        "TransferWithAuthorization": [
            {"name": "from", "type": "address"},
            {"name": "to", "type": "address"},
            {"name": "value", "type": "uint256"},
            {"name": "validAfter", "type": "uint256"},
            {"name": "validBefore", "type": "uint256"},
            {"name": "nonce", "type": "bytes32"},
        ],
    }
    message_data = {
        "from": account.address,
        "to": pay_to,
        "value": amount,
        "validAfter": 0,
        "validBefore": deadline,
        "nonce": nonce,
    }

    signed = Account.sign_typed_data(
        _PRIVATE_KEY,
        domain_data=domain_data,
        message_types=message_types,
        message_data=message_data,
    )

    payload = {
        "x402Version": 1,
        "scheme": "exact",
        "network": _NETWORK,
        "payload": {
            "signature": "0x" + signed.signature.hex(),
            "authorization": {
                "from": account.address,
                "to": pay_to,
                "value": str(amount),
                "validAfter": "0",
                "validBefore": str(deadline),
                "nonce": "0x" + nonce.hex(),
            },
        },
    }
    return base64.b64encode(json.dumps(payload).encode()).decode()


def _handle_sync_402(response, request_fn, original_request):
    """Handle a 402 response: sign payment and retry."""
    try:
        payment_requirements = response.json()
    except Exception:
        return response

    # USDC has 6 decimal places, not 18 like most ERC-20 tokens
    amount_usd = int(payment_requirements.get("maxAmountRequired", 0)) / 1e6
    payment_header = _build_payment_header(payment_requirements)
    original_request.headers["X-PAYMENT"] = payment_header
    retry_response = request_fn(original_request)

    tx_hash = retry_response.headers.get("X-PAYMENT-RESPONSE", "unknown")
    status = "success" if retry_response.status_code != 402 else "failed"
    _check_and_log_payment(amount_usd, str(original_request.url), tx_hash, status)

    return retry_response


# Only patch if credentials are present
if _PRIVATE_KEY:
    try:
        import httpx

        _original_send = httpx.Client.send

        def _patched_send(self, request, **kwargs):
            # Skip if we're already inside a payment handler (re-entrancy guard)
            if getattr(_payment_in_progress, "active", False):
                return _original_send(self, request, **kwargs)
            # Never intercept E2B's own API calls
            if str(request.url.host) in _E2B_API_HOSTS:
                return _original_send(self, request, **kwargs)
            response = _original_send(self, request, **kwargs)
            if response.status_code == 402:
                _payment_in_progress.active = True
                try:
                    return _handle_sync_402(
                        response,
                        lambda req: _original_send(self, req, **kwargs),
                        request,
                    )
                finally:
                    _payment_in_progress.active = False
            return response

        httpx.Client.send = _patched_send

        _original_async_send = httpx.AsyncClient.send

        async def _patched_async_send(self, request, **kwargs):
            if getattr(_payment_in_progress, "active", False):
                return await _original_async_send(self, request, **kwargs)
            if str(request.url.host) in _E2B_API_HOSTS:
                return await _original_async_send(self, request, **kwargs)
            response = await _original_async_send(self, request, **kwargs)
            if response.status_code == 402:
                _payment_in_progress.active = True
                try:
                    account = _get_account()
                    if account is None:
                        return response
                    try:
                        payment_requirements = response.json()
                    except Exception:
                        return response
                    # USDC has 6 decimal places, not 18 like most ERC-20 tokens
                    amount_usd = int(payment_requirements.get("maxAmountRequired", 0)) / 1e6
                    payment_header = _build_payment_header(payment_requirements)
                    request.headers["X-PAYMENT"] = payment_header
                    retry_response = await _original_async_send(self, request, **kwargs)
                    tx_hash = retry_response.headers.get("X-PAYMENT-RESPONSE", "unknown")
                    status = "success" if retry_response.status_code != 402 else "failed"
                    _check_and_log_payment(amount_usd, str(request.url), tx_hash, status)
                    return retry_response
                finally:
                    _payment_in_progress.active = False
            return response

        httpx.AsyncClient.send = _patched_async_send

    except ImportError:
        pass
