# The official image already ships the Chromium revision pinned by this exact
# Playwright version. Avoids a build-time download from cdn.playwright.dev.
FROM mcr.microsoft.com/playwright:v1.64.0-noble
WORKDIR /app/worker
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
COPY worker/package.json worker/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY worker/*.mjs worker/models.json ./
COPY public /app/public
COPY schema/simulation.schema.json schema/generation-protocol.json /app/schema/
COPY docs/simulation-authoring.md docs/generation-engine-api.md /app/docs/
RUN mkdir -p /var/lib/commonlab/agent-traces /var/lib/commonlab/checkpoints && chown -R 10001:10001 /var/lib/commonlab && chmod 0700 /var/lib/commonlab/agent-traces /var/lib/commonlab/checkpoints
USER 10001:10001
ENV NODE_ENV=production HOME=/tmp CL_CHECKPOINT_DIR=/var/lib/commonlab/checkpoints
HEALTHCHECK --interval=15s --timeout=3s --start-period=30s CMD ["node", "-e", "require('node:fs').accessSync('/tmp/commonlab-worker-ready')"]
CMD ["node", "supervisor.mjs"]
