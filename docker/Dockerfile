# Parallel Code — Docker agent image
# Pre-installs common dev tools so agents don't waste time on setup.
# Build:  docker build -t parallel-code-agent:latest docker/
# Size target: ~600 MB (multi-stage not needed; one fat layer is fine for a dev image)

FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8

# Core build tools + languages
RUN apt-get update && apt-get install -y --no-install-recommends \
    # Basics
    ca-certificates curl wget git openssh-client gnupg \
    # Build essentials
    build-essential pkg-config \
    # Python
    python3 python3-pip python3-venv \
    # Shells & utilities
    bash zsh jq ripgrep fd-find fzf tree unzip less \
    # Process inspection
    procps \
    # Networking
    dnsutils iputils-ping netcat-openbsd \
    # Editor (agents sometimes need a $EDITOR)
    nano \
    && rm -rf /var/lib/apt/lists/*

# Add apt repos: NodeSource (Node 22 LTS) and GitHub CLI
RUN mkdir -p /etc/apt/keyrings \
    && curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
         | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg \
    && echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" \
         > /etc/apt/sources.list.d/nodesource.list \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
         | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
         > /etc/apt/sources.list.d/github-cli.list

# Install Node.js, npm, and GitHub CLI in one layer
RUN apt-get update && apt-get install -y --no-install-recommends \
    nodejs \
    git-lfs \
    gh \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g npm@10

# Make fd and fdfind available as 'fd'
RUN ln -sf "$(command -v fdfind)" /usr/local/bin/fd 2>/dev/null || true

# Default git config so commits work out of the box inside containers
RUN git config --system init.defaultBranch main \
    && git config --system advice.detachedHead false

# Non-root user — use --user 1000:1000 in docker run as needed
RUN groupadd --gid 1000 agent \
    && useradd --uid 1000 --gid agent --shell /bin/bash --create-home agent

# Set a reasonable default shell
ENV SHELL=/bin/bash
WORKDIR /app

CMD ["bash"]
