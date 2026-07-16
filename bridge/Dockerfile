# Ubuntu 22.04 + Wine + MT5 + Python bridge.
# Build:  docker build -t mt5-bridge bridge/
# Run:    docker run --env-file bridge/.env -v mt5wine:/home/mt5/.wine-mt5 mt5-bridge
FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive \
    WINEPREFIX=/home/mt5/.wine-mt5 \
    WINEARCH=win64 \
    DISPLAY=:99 \
    PYTHONUNBUFFERED=1

RUN dpkg --add-architecture i386 && apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl wget gnupg xvfb xauth cabextract unzip \
    python3 python3-pip python3-venv software-properties-common && \
    mkdir -p /etc/apt/keyrings && \
    wget -qO- https://dl.winehq.org/wine-builds/winehq.key | gpg --dearmor -o /etc/apt/keyrings/winehq-archive.key && \
    wget -qO /etc/apt/sources.list.d/winehq.sources https://dl.winehq.org/wine-builds/ubuntu/dists/jammy/winehq-jammy.sources && \
    apt-get update && apt-get install -y --install-recommends winehq-stable && \
    rm -rf /var/lib/apt/lists/*

RUN useradd -m -s /bin/bash mt5
USER mt5
WORKDIR /home/mt5/bridge

COPY --chown=mt5:mt5 requirements.txt ./
RUN python3 -m venv /home/mt5/.venv && \
    /home/mt5/.venv/bin/pip install --no-cache-dir -r requirements.txt

COPY --chown=mt5:mt5 . ./

HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
  CMD bash scripts/healthcheck.sh || exit 1

CMD ["bash", "scripts/entrypoint.sh"]