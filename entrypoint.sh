#!/bin/bash
set -eo pipefail

export GIT_TERMINAL_PROMPT=0

echo "===================================================="
echo "[Startup] Initializing Anime4K Upscaler Environment"
echo "===================================================="

# 1. Platform & GPU Auto-Discovery
if [ -n "$MODAL_TASK_ID" ] || [ -n "$MODAL_IS_REMOTE" ] || [ -n "$MODAL_ENVIRONMENT" ]; then
    export RUNNER_PLATFORM="modal"
elif [ -n "$HYPERSTACK_API_KEY" ]; then
    export RUNNER_PLATFORM="hyperstack"
elif [ -n "$VAST_CONTAINERLABEL" ] || [ -n "$CONTAINER_ID" ]; then
    export RUNNER_PLATFORM="vast"
else
    export RUNNER_PLATFORM="generic"
fi

if command -v nvidia-smi &> /dev/null; then
    export RUNNER_GPU_NAME=$(nvidia-smi --query-gpu=name --format=csv,noheader | head -n 1 | xargs)
    export RUNNER_GPU_COUNT=$(nvidia-smi --query-gpu=name --format=csv,noheader | wc -l | xargs)
    export RUNNER_GPU_VRAM=$(nvidia-smi --query-gpu=memory.total --format=csv,noheader | head -n 1 | xargs)
else
    export RUNNER_GPU_NAME="None"
    export RUNNER_GPU_COUNT="0"
    export RUNNER_GPU_VRAM="0"
fi

MACHINE_ID=$(hostname)
API_BASE_URL="${API_BASE_URL:-https://api.runltx.com}"

echo "[Platform] Runtime  : $RUNNER_PLATFORM"
echo "[Hardware] GPU Model: $RUNNER_GPU_NAME ($RUNNER_GPU_COUNT detected, $RUNNER_GPU_VRAM VRAM)"
echo "===================================================="

# 2. Register worker startup session via /v1/worker/on
echo "[Billing] Registering worker startup session via /v1/worker/on..."
SESSION_PAYLOAD=$(cat <<EOF
{
  "machine_id": "${MACHINE_ID}",
  "provider": "${RUNNER_PLATFORM}",
  "gpu_name": "${RUNNER_GPU_NAME}",
  "gpu_count": ${RUNNER_GPU_COUNT},
  "gpu_vram": "${RUNNER_GPU_VRAM}"
}
EOF
)

SESSION_RESPONSE=$(curl -s -X POST "${API_BASE_URL}/v1/worker/on" \
    -H "Content-Type: application/json" \
    -H "worker-auth: ${WORKER_API_SECRET}" \
    -H "x-machine-id: ${MACHINE_ID}" \
    -d "${SESSION_PAYLOAD}" || echo '{"success":false}')

export WORKER_SESSION_ID=$(echo "$SESSION_RESPONSE" | node -e "
    const fs = require('fs');
    try {
        const res = JSON.parse(fs.readFileSync(0, 'utf-8'));
        if (res.success && res.session_id) process.stdout.write(res.session_id);
    } catch (_) {}
")

if [ -n "$WORKER_SESSION_ID" ]; then
    echo "[Billing] Active Worker Session ID: ${WORKER_SESSION_ID}"
else
    echo "[Billing Warning] Could not initialize session tracking."
fi

# 3. Setup isolated XDG runtime directory and start Xvfb
export XDG_RUNTIME_DIR=/tmp/runtime-root
mkdir -p "$XDG_RUNTIME_DIR"
chmod 700 "$XDG_RUNTIME_DIR"

# 3a. Set up worker directories (input + output)
export WORK_DIR="${WORK_DIR:-/tmp/upscaler}"
export OUTPUT_DIR="${OUTPUT_DIR:-/root/Downloads}"
mkdir -p "$WORK_DIR" "$OUTPUT_DIR"
rm -f "$OUTPUT_DIR"/*.webm 2>/dev/null || true
echo "[Storage] WORK_DIR   = $WORK_DIR"
echo "[Storage] OUTPUT_DIR = $OUTPUT_DIR"

echo "[Display] Starting Xvfb on :99..."
rm -f /tmp/.X99-lock /tmp/.X11-unix/X99
Xvfb :99 -screen 0 1920x1080x24 -nolisten tcp &
XVFB_PID=$!

until [ -S /tmp/.X11-unix/X99 ]; do
    sleep 0.1
done
echo "[Display] Xvfb is ready on DISPLAY=:99."

# 3b. Repair the ICD manifest so its library_path names a file that EXISTS here.
# The image ships an EGL-based manifest (libEGL_nvidia.so.0). libGLX_nvidia is
# NOT used as the default because its ICD entry point requires an X11/GLX client
# context and returns NULL in a minimal container -> "Found no drivers!". Only
# rewrite when the manifest is missing or still points at GLX.
ICD_FILE=/etc/vulkan/icd.d/nvidia_icd.json
if [ -d /etc/vulkan/icd.d ]; then
    if [ ! -f "$ICD_FILE" ] || ! grep -q 'libEGL_nvidia' "$ICD_FILE" 2>/dev/null; then
        EGL_REAL=""
        for p in /usr/lib/x86_64-linux-gnu/libEGL_nvidia.so* /usr/lib64/libEGL_nvidia.so* /usr/lib/libEGL_nvidia.so*; do
            [ -e "$p" ] && EGL_REAL="$p" && break
        done
        if [ -n "$EGL_REAL" ]; then
            echo "[Vulkan] ICD library_path -> $EGL_REAL"
            cat > "$ICD_FILE" <<ICD_JSON
{
  "file_format_version": "1.0.0",
  "ICD": {
    "library_path": "$EGL_REAL",
    "api_version": "1.4.329"
  }
}
ICD_JSON
        else
            echo "[Vulkan] WARNING: no libEGL_nvidia.so* found; leaving manifest as shipped."
        fi
    fi
fi

# 3b-egl. Opt-in EGL ICD. libEGL_nvidia is also a complete Vulkan ICD and, unlike
# libGLX_nvidia, does not initialise the X11/GLX client path - which is what
# makes vkCreateInstance return NULL in minimal containers. EGL is therefore the
# DEFAULT; set RTX_USE_EGL_ICD=0 to opt back into the GLX manifest for debugging.
if [ "${RTX_USE_EGL_ICD:-1}" = "1" ]; then
    EGL_ICD=/tmp/egl_icd.d/nvidia_icd.json
    mkdir -p "$(dirname "$EGL_ICD")"
    cat > "$EGL_ICD" <<'EGL_JSON'
{
  "file_format_version": "1.0.0",
  "ICD": {
    "library_path": "libEGL_nvidia.so.0",
    "api_version": "1.4.329"
  }
}
EGL_JSON
    export VK_DRIVER_FILES="$EGL_ICD"
    unset VK_ICD_FILENAMES
    echo "[Vulkan] using EGL ICD: $EGL_ICD"
fi

# 3c. HARD GATE: Vulkan must be present. No software fallback.
echo "[Vulkan] Verifying NVIDIA hardware Vulkan..."
if ! env -u DISPLAY XDG_RUNTIME_DIR="$XDG_RUNTIME_DIR" vulkaninfo --summary 2>/dev/null | grep -q "NVIDIA"; then
    echo "[Vulkan] FATAL: NVIDIA Vulkan device not detected."
    echo "[Vulkan] ================ DIAGNOSTICS ================"
    echo "[Vulkan] --- loader env:"
    echo "    VK_DRIVER_FILES    = ${VK_DRIVER_FILES:-<unset>}"
    echo "    VK_ICD_FILENAMES   = ${VK_ICD_FILENAMES:-<unset>}"
    echo "    NVIDIA_DRIVER_CAPS = ${NVIDIA_DRIVER_CAPABILITIES:-<unset>}"
    echo "[Vulkan] --- icd dirs:"
    ls -la /etc/vulkan/icd.d/ /usr/share/vulkan/icd.d/ 2>/dev/null || true
    echo "[Vulkan] --- manifest contents:"
    for m in /etc/vulkan/icd.d/*.json /tmp/egl_icd.d/*.json; do
        [ -e "$m" ] && { echo "    [$m]"; sed 's/^/      /' "$m"; }
    done
    echo "[Vulkan] --- nvidia libs present:"
    ls /usr/lib/x86_64-linux-gnu/lib*nvidia*so* /usr/lib/x86_64-linux-gnu/libGLX_nvidia* /usr/lib/x86_64-linux-gnu/libEGL_nvidia* 2>/dev/null | head -30 || true
    echo "[Vulkan] --- device nodes:"
    ls -la /dev/nvidia* 2>/dev/null || echo "    (none)"
    echo "[Vulkan] --- loader debug (why vkCreateInstance fails):"
    VK_LOADER_DEBUG=error,warn env -u DISPLAY XDG_RUNTIME_DIR="$XDG_RUNTIME_DIR" \
        vulkaninfo --summary 2>&1 | grep -iE "error|fail|could not|unable" | head -15 || true
    echo "[Vulkan] --- strace of files the driver tries to open:"
    if command -v strace >/dev/null 2>&1; then
        env -u DISPLAY XDG_RUNTIME_DIR="$XDG_RUNTIME_DIR" \
            strace -f -e trace=%file vulkaninfo --summary 2>&1 \
            | grep ENOENT | grep -iE "\.so|nvidia|glx|egl|dri" | sort -u | tail -20 || true
    else
        echo "    (strace not installed - rebuild image with strace to see this)"
    fi
    echo "[Vulkan] ============================================="
    kill -9 $XVFB_PID 2>/dev/null || true
    exit 1
fi
echo "[Vulkan] NVIDIA hardware Vulkan verified."

# 4. Launch Worker Loop
export DISPLAY=:99
node worker.js
WORKER_EXIT_CODE=$?

# Teardown Xvfb
kill -9 $XVFB_PID 2>/dev/null || true

# 5. Register worker shutdown via /v1/worker/off
echo "[Billing] Finalizing worker session via /v1/worker/off..."
STATS_FILE="/tmp/worker_stats.json"
JOBS_PROCESSED=0
TOTAL_GEN_TIME=0

if [ -f "$STATS_FILE" ]; then
    JOBS_PROCESSED=$(node -e "const fs = require('fs'); try { console.log(JSON.parse(fs.readFileSync('$STATS_FILE')).jobs_processed || 0); } catch(_) { console.log(0); }")
    TOTAL_GEN_TIME=$(node -e "const fs = require('fs'); try { console.log(JSON.parse(fs.readFileSync('$STATS_FILE')).total_generation_time_sec || 0); } catch(_) { console.log(0); }")
fi

OFF_PAYLOAD=$(cat <<EOF
{
  "session_id": "${WORKER_SESSION_ID}",
  "machine_id": "${MACHINE_ID}",
  "jobs_processed": ${JOBS_PROCESSED},
  "total_generation_time_sec": ${TOTAL_GEN_TIME}
}
EOF
)

curl -s -X POST "${API_BASE_URL}/v1/worker/off" \
    -H "Content-Type: application/json" \
    -H "worker-auth: ${WORKER_API_SECRET}" \
    -H "x-machine-id: ${MACHINE_ID}" \
    -d "${OFF_PAYLOAD}" || true

echo "[Billing] Session closed."
exit $WORKER_EXIT_CODE
