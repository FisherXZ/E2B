"""
E2B x402 payment interceptor.
Auto-activates when E2B_PAYMENT_PRIVATE_KEY is set.
Wraps httpx.Client and httpx.AsyncClient to handle HTTP 402 responses automatically.
"""

import base64
import binascii
import fcntl
import json
import os
import threading
import time
from pathlib import Path
from typing import Optional, Tuple

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
# CAIP-2 aliases — x402 v2 servers use this format ("eip155:84532") instead of
# the human-friendly name ("base-sepolia"). Map both directions so we can match
# accepts[] entries regardless of which form the server emits.
_NETWORK_ALIASES = {
    "base": {"base", "eip155:8453"},
    "base-sepolia": {"base-sepolia", "eip155:84532"},
}

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


def _decode_header(header_value: str) -> Optional[dict]:
    """Decode a base64-encoded payment-required header. Returns None if invalid."""
    if not header_value:
        return None
    try:
        # Tolerate missing padding
        padded = header_value + "=" * (-len(header_value) % 4)
        return json.loads(base64.b64decode(padded).decode())
    except (binascii.Error, ValueError, UnicodeDecodeError, json.JSONDecodeError):
        return None


def _select_accept(envelope: dict) -> Optional[dict]:
    """Pick an accepts[] entry matching the configured network.

    x402 v2: { x402Version, accepts: [{scheme, network, asset, payTo, maxAmountRequired, maxTimeoutSeconds, ...}] }
    Falls back to treating the envelope itself as a v1-style flat requirement object.
    """
    accepts = envelope.get("accepts")
    if isinstance(accepts, list) and accepts:
        wanted = _NETWORK_ALIASES.get(_NETWORK, {_NETWORK})
        for entry in accepts:
            if not isinstance(entry, dict):
                continue
            net = entry.get("network", "")
            scheme = entry.get("scheme", "exact")
            if net in wanted and scheme == "exact":
                return entry
        # No exact-network match — fall through to first 'exact' entry
        for entry in accepts:
            if isinstance(entry, dict) and entry.get("scheme", "exact") == "exact":
                return entry
        return accepts[0] if isinstance(accepts[0], dict) else None
    # Legacy v1 flat shape
    if "asset" in envelope or "usdcAddress" in envelope:
        return envelope
    return None


def _extract_requirements(response) -> Tuple[Optional[dict], Optional[str]]:
    """Pull payment requirements from the 402 response.

    Prefers the `payment-required` HTTP header (x402 v2), falls back to the response body.
    Returns (selected_accept_entry, response_network) — response_network is what we should
    echo back in the X-PAYMENT payload's `network` field so the server accepts our reply.
    """
    header_val = response.headers.get("payment-required") or response.headers.get("Payment-Required")
    envelope = _decode_header(header_val) if header_val else None
    if envelope is None:
        try:
            envelope = response.json()
        except Exception:
            return None, None
    if not isinstance(envelope, dict):
        return None, None
    entry = _select_accept(envelope)
    if entry is None:
        return None, None
    return entry, entry.get("network", _NETWORK)


def _read_amount_usd(entry: dict) -> float:
    """USDC has 6 decimal places, not 18 like most ERC-20 tokens."""
    raw = entry.get("maxAmountRequired", 0)
    try:
        return int(raw) / 1e6
    except (TypeError, ValueError):
        return 0.0


def _build_payment_header(entry: dict, response_network: str) -> str:
    """Build base64-encoded X-PAYMENT header using EIP-3009 TransferWithAuthorization."""
    from eth_account import Account
    import secrets as _secrets

    account = _get_account()
    if account is None:
        raise RuntimeError("E2B_PAYMENT_PRIVATE_KEY not set")

    # x402 v2 field names with v1 fallbacks for compatibility with older servers
    usdc_address = entry.get("asset") or entry.get("usdcAddress")
    pay_to = entry.get("payTo") or entry.get("payToAddress")
    if not usdc_address or not pay_to:
        raise RuntimeError("Payment requirements missing asset/payTo")
    amount = int(entry["maxAmountRequired"])
    timeout_seconds = int(entry.get("maxTimeoutSeconds") or entry.get("requiredDeadlineSeconds") or 300)
    deadline = int(time.time()) + timeout_seconds
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
        "scheme": entry.get("scheme", "exact"),
        # Echo the server's network string verbatim — facilitators reject mismatches
        # between what they sent in `accepts[i].network` and what we send back.
        "network": response_network,
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
    entry, response_network = _extract_requirements(response)
    if entry is None:
        return response

    amount_usd = _read_amount_usd(entry)
    payment_header = _build_payment_header(entry, response_network)
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
                    entry, response_network = _extract_requirements(response)
                    if entry is None:
                        return response
                    amount_usd = _read_amount_usd(entry)
                    payment_header = _build_payment_header(entry, response_network)
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
