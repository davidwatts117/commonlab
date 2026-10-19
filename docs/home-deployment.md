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
