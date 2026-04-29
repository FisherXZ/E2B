FROM e2bdev/code-interpreter:latest

USER root

# Copy payment interceptor
COPY e2b-payments/ /usr/local/lib/e2b-payments/

# Install viem locally so ESM resolution finds it relative to the interceptor
RUN cd /usr/local/lib/e2b-payments && npm install viem

COPY --chmod=755 init.sh /etc/e2b-payments-init.sh

# --import (not --require) runs the module through the ESM loader with top-level
# await support, guaranteeing the fetch patch is installed before any user code runs.
# --require fires a CJS require() which cannot await a dynamic import(), creating a
# race where the first fetch() call in agent code executes before the patch lands.
# Requires Node.js >= 18.19.
ENV NODE_OPTIONS="--import /usr/local/lib/e2b-payments/index.mjs"
