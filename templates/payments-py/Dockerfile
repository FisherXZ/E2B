FROM e2bdev/code-interpreter:latest

USER root

# Install x402 payment dependencies
RUN pip install eth-account>=0.11.0 httpx>=0.27.0

# Copy the e2b_payments interceptor to the active Python's site-packages (version-agnostic)
COPY e2b_payments/ /tmp/e2b_payments/
RUN dest="$(python3 -c 'import site; print(site.getsitepackages()[0])')/e2b_payments" && \
    cp -r /tmp/e2b_payments/. "$dest/" && \
    rm -rf /tmp/e2b_payments

# Copy and set up init script
COPY --chmod=755 init.sh /etc/e2b-payments-init.sh

# Auto-activate interceptor: append to the sitecustomize.py this Python version actually loads.
# Use echo (not python -c) to avoid \n escape handling differences across sh/Docker layers.
RUN echo 'import e2b_payments' >> "$(python3 -c 'import site; print(site.getsitepackages()[0])')/sitecustomize.py"
