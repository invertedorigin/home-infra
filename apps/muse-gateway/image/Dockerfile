# muse-gateway image
#
# Anthropic does not publish an official Claude Code OCI image, so this image
# installs the npm CLI (@anthropic-ai/claude-code) on Node 22, plus the local
# toolchain the gateway exposes: kubectl, git, gh, python3.
#
# Build + push (manual step before this app can deploy — see README.md):
#   docker build -t ghcr.io/invertedorigin/muse-gateway:latest apps/muse-gateway/image
#   docker push ghcr.io/invertedorigin/muse-gateway:latest
#
# Pin to a digest in deployment.yaml once the first image is published.
FROM node:22-bookworm-slim

ARG KUBECTL_VERSION=v1.34.0

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates curl git gh python3 \
  && curl -fsSL "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/amd64/kubectl" \
      -o /usr/local/bin/kubectl \
  && chmod +x /usr/local/bin/kubectl \
  && npm install -g @anthropic-ai/claude-code \
  && apt-get purge -y curl \
  && apt-get autoremove -y \
  && rm -rf /var/lib/apt/lists/* \
  && claude --version \
  && kubectl version --client \
  && node --version

WORKDIR /app
COPY gateway.mjs /app/gateway.mjs

# Non-root user matching the Deployment's runAsUser/fsGroup (1000).
RUN useradd -m -u 1000 agent \
  && mkdir -p /home/agent/.claude /workspace \
  && chown -R agent:agent /app /home/agent /workspace
USER agent

EXPOSE 8080
CMD ["node", "/app/gateway.mjs"]
