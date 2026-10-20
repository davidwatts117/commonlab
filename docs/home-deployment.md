# Home deployment

`compose.home.yaml` runs CommonLab, its OpenRouter worker, and Cloudflared
without publishing host ports. Images are built on the host; no registry push
is needed. The deployment directory is `~/apps/commonlab` on `patrick@home`.

## Secrets and launch

Edit `~/apps/commonlab/.env` on the host (permissions must stay `600`):

- `ADMIN_TOKEN`: generated administrator token; enter it at `/review.html`.
- `GENERATION_WORKER_TOKEN`: generated shared application/worker token.
- `CL_MODEL_API_KEY`: dedicated OpenRouter key, with provider-side spend limits.
- `CLOUDFLARE_TUNNEL_TOKEN`: rotated tunnel token.

Do not paste secrets or resolved Compose configuration into logs or chat.
In Cloudflare, configure the tunnel's public hostname
`commonlab.poberholzer.com` with service `http://app:8000`.
The browser connection uses HTTPS; the worker uses the private Docker network.
No existing tunnel containers need to be modified.

After filling both empty secrets:

```sh
cd ~/apps/commonlab
docker compose -f compose.home.yaml --profile generation --profile tunnel up -d
```

The worker uses `openrouter` and `xiaomi/mimo-v2.6-flash`. Changing these
requires editing the Compose file and recreating the worker. Registration
does not grant AI access: approve the contributor in the review UI, then
request a generation at `/generate.html`. This incurs provider charges.
Generated engines remain private until explicitly submitted and reviewed.

## Optional local agent traces

To capture operator-only development transcripts, add this non-secret setting to the host `.env`:

```dotenv
CL_AGENT_TRACE_DIR=/var/lib/commonlab/agent-traces
CL_AGENT_TRACE_MAX_FILES=50
CL_AGENT_TRACE_MAX_BYTES=8388608
CL_AGENT_TRACE_MAX_DAYS=7
```

Recreate the worker using the same profile launch command. The Compose file provides a worker-only named volume (`commonlab_generation-traces`); the app and tunnel cannot serve it. Files are mode `0600` under a `0700` directory. Traces include prompts, intermediate source and tool results, exclude private reasoning, and redact known credentials. Do not paste them into public logs. Leaving `CL_AGENT_TRACE_DIR` empty disables tracing.

List or copy files locally as the operator, for example:

```sh
cd ~/apps/commonlab
docker compose -f compose.home.yaml exec -T generation-worker ls /var/lib/commonlab/agent-traces
# Inspect a particular named file privately; never serve this directory over HTTP.
docker cp commonlab-generation-worker-1:/var/lib/commonlab/agent-traces/generation-<job>-<time>-<uuid>.jsonl /secure/local/path/
```

Retention is independent of SQLite and runs at the start of each traced job. See [AI generation](ai-generation.md#optional-operator-only-agent-traces) for size caps, redaction and interrupted-run limitations.

## Operations

Builds use host networking to work around this host's BuildKit DNS failure.
Buildx requires an explicit entitlement (runtime networking stays private):

```sh
cd ~/apps/commonlab
docker buildx bake -f compose.home.yaml --allow=network.host --load \
  app generation-worker
```

Then recreate services with the launch command above. Do not add `--build`
to Compose on this host; use the explicit Buildx command instead.

```sh
cd ~/apps/commonlab
docker compose -f compose.home.yaml --profile generation --profile tunnel ps
docker compose -f compose.home.yaml logs --tail=100 app
```

Profiles keep the worker and tunnel out of an app-only first launch. Once
started, services restart automatically unless stopped. Use the same profiles
when stopping the whole stack. Never use `down -v` unless deleting all data is
intentional. See [deployment.md](deployment.md) for backups, recovery,
monitoring, and publication safety. Cloudflare ingress does not replace abuse
controls; configure suitable Cloudflare rate limits/access policies before
opening registration broadly.
