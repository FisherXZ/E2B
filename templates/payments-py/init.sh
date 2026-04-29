#!/bin/bash
# Initialize e2b payments state files if payment credentials are present
if [ -n "$E2B_PAYMENT_PRIVATE_KEY" ]; then
    touch /tmp/.e2b-payments.jsonl
    if [ -n "$E2B_PAYMENT_MAX_SPEND" ]; then
        echo "$E2B_PAYMENT_MAX_SPEND" > /tmp/.e2b-payment-limit
    fi
fi
