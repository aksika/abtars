FROM node:22-slim

# Chrome dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
    libxkbcommon0 libxcomposite1 libxdamage1 libxrandr2 libgbm1 \
    libpango-1.0-0 libcairo2 libasound2 libxshmfence1 \
    fonts-liberation fonts-noto-color-emoji \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install deps and build
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src/ src/
RUN npm run build

# Install Patchright Chrome (sandbox works inside Docker)
RUN npx patchright install chrome

# Socket mount point
RUN mkdir -p /run/browser

ENV BROWSER_SOCKET_PATH=/run/browser/browser.sock
ENV BROWSER_CHANNEL=chrome
ENV BROWSER_NO_SANDBOX=1

# Writable dirs for non-root user
RUN mkdir -p /tmp /run/browser && chmod 777 /tmp /run/browser

# Default: headless. Set BROWSER_HEADED=1 and mount X11 socket for visible mode.
CMD ["node", "dist/cli/browser-server.js"]
