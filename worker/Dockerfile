FROM node:24-bookworm-slim
WORKDIR /app/worker
COPY worker/package.json worker/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY worker/*.mjs ./
COPY public/simulation-schema.mjs /app/public/simulation-schema.mjs
COPY schema/simulation.schema.json /app/schema/simulation.schema.json
COPY docs/simulation-authoring.md /app/docs/simulation-authoring.md
RUN mkdir -p /var/lib/commonlab/agent-traces && chown 10001:10001 /var/lib/commonlab/agent-traces && chmod 0700 /var/lib/commonlab/agent-traces
USER 10001:10001
ENV NODE_ENV=production HOME=/tmp
CMD ["node", "supervisor.mjs"]
