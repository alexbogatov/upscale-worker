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

# 5. Vulkan ICD manifest for the NVIDIA driver.
#    libvulkan1 (the loader) is installed above, but the loader needs an ICD
#    manifest to discover any driver. The NVIDIA *driver itself* is supplied at
#    runtime by nvidia-container-toolkit (it is kernel-locked and cannot be
#    redistributed in an image), so we only ship the pointer to it.
#
#    library_path is deliberately BARE (no directory): the loader resolves it
#    through the normal library search path, so it works wherever the toolkit
#    mounts the driver. Metal/software drivers are not listed - if NVIDIA is
#    absent, entrypoint.sh is supposed to fail loudly rather than fall back.
RUN mkdir -p /etc/vulkan/icd.d && \
    printf '%s\n' \
      '{' \
      '  "file_format_version": "1.0.0",' \
      '  "ICD": {' \
      '    "library_path": "libGLX_nvidia.so.0",' \
      '    "api_version": "1.3.275"' \
      '  }' \
      '}' > /etc/vulkan/icd.d/nvidia_icd.json && \
    cat /etc/vulkan/icd.d/nvidia_icd.json

# Tell the loader explicitly. Harmless if the toolkit already sets these.
ENV VK_DRIVER_FILES=/etc/vulkan/icd.d/nvidia_icd.json
ENV VK_ICD_FILENAMES=/etc/vulkan/icd.d/nvidia_icd.json

ENV DISPLAY=:99
ENV XDG_RUNTIME_DIR=/tmp/runtime-root

ENTRYPOINT ["./entrypoint.sh"]
