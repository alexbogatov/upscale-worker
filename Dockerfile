FROM node:20-bookworm

ENV DEBIAN_FRONTEND=noninteractive

# 1. System packages, Chrome runtime libraries, tools, Xvfb, Vulkan, and EGL/GLVND dispatchers
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates wget curl gnupg \
    fonts-liberation \
    libasound2 libatk-bridge2.0-0 libatk1.0-0 libatspi2.0-0 \
    libcairo2 libcups2 libdbus-1-3 libdrm2 libgbm1 \
    libglib2.0-0 libgtk-3-0 libnspr4 libnss3 libpango-1.0-0 \
    libx11-6 libxcb1 libxcomposite1 libxdamage1 libxext6 \
    libxfixes3 libxkbcommon0 libxrandr2 libxshmfence1 \
    libvulkan1 vulkan-tools \
    libegl1 libglvnd0 libglx0 \
    xdg-utils xvfb procps \
 && rm -rf /var/lib/apt/lists/*

# 2. Chrome from Google's official repo
RUN wget -q -O - https://dl-ssl.google.com/linux/linux_signing_key.pub \
      | gpg --dearmor -o /usr/share/keyrings/google-chrome.gpg \
 && echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google-chrome.gpg] http://dl.google.com/linux/chrome/deb/ stable main" \
      > /etc/apt/sources.list.d/google-chrome.list \
 && apt-get update \
 && apt-get install -y google-chrome-stable --no-install-recommends \
 && rm -rf /var/lib/apt/lists/*

# 3. App directory and Node dependencies
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev

# 4. App source files
COPY worker.js entrypoint.sh ./
COPY upscaler/ ./upscaler/

RUN chmod +x entrypoint.sh

ENV DISPLAY=:99
ENV XDG_RUNTIME_DIR=/tmp/runtime-root

ENTRYPOINT ["./entrypoint.sh"]