# The official image already ships the Chromium revision pinned by this exact
# Playwright version. Avoids a build-time download from cdn.playwright.dev.
FROM mcr.microsoft.com/playwright:v1.64.0-noble
WORKDIR /app/worker
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
COPY worker/package.json worker/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY worker/*.mjs worker/models.json ./
COPY public /app/public
COPY schema/simulation.schema.json /app/schema/simulation.schema.json
COPY docs/simulation-authoring.md /app/docs/simulation-authoring.md
RUN mkdir -p /var/lib/commonlab/agent-traces && chown 10001:10001 /var/lib/commonlab/agent-traces && chmod 0700 /var/lib/commonlab/agent-traces
USER 10001:10001
ENV NODE_ENV=production HOME=/tmp
CMD ["node", "supervisor.mjs"]
