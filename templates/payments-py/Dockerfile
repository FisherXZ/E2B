FROM e2bdev/code-interpreter:latest

# Install x402 payment dependencies
RUN pip install eth-account>=0.11.0 httpx>=0.27.0

# Copy the e2b_payments interceptor package
COPY e2b_payments/ /usr/local/lib/python3.11/site-packages/e2b_payments/

# Copy and set up init script
COPY init.sh /etc/e2b-payments-init.sh
RUN chmod +x /etc/e2b-payments-init.sh

# Auto-activate interceptor for every Python process if credentials are present
RUN echo 'import e2b_payments' >> /usr/lib/python3/dist-packages/sitecustomize.py || \
    echo 'import e2b_payments' > /usr/local/lib/python3.11/site-packages/sitecustomize.py
