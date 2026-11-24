# muse-gateway

Muse's gateway pod on the home cluster: a Tailscale-only HTTP API that lets
Muse (cloud) run a local toolchain and Claude Code tasks inside the home
network, and retrieve allowlisted secrets that live in the pod.

**Status: draft.** Do not merge until the pre-merge checklist below is done.

## Architecture

```
Muse VM (cloud, Tailscale client `muse`)
  │  Bearer MUSE_GATEWAY_TOKEN, over the tailnet (encrypted by Tailscale)
  ▼
muse-gateway.<tailnet>.ts.net:8080          <- Tailscale Service (no public Ingress)
  │  tailscale-operator proxy pod
  ▼
muse-gateway Deployment (1 replica, namespace muse-gateway)
  └─ gateway container (node:22 + Claude Code CLI, see image/Dockerfile)
       ├─ POST /v1/tasks      -> claude -p --output-format json (headless)
       ├─ POST /v1/toolchain  -> allowlisted read-only tools (kubectl get/describe,
       │                         git status/log/diff, helm list/status)
       └─ GET  /v1/secrets/:name -> one allowlisted secret, audit-logged
```

- **ArgoCD:** adding `overlays/apps` auto-discovers this app via the
  `apps` ApplicationSet (`argocd-config/appsets/apps/appset.yaml`), same as
  opencode/homeassistant. Sync is automated, `prune: false`, `selfHeal: false`.
- **Secrets:** Doppler, via the existing `doppler-auth-api` ClusterSecretStore
  and an ExternalSecret — the same pattern as every other app here. No secret
  values are in git, ever.
- **Claude Code:** Anthropic publishes no official Claude Code OCI image, so
  `image/Dockerfile` installs the npm CLI on Node 22. Auth is
  `ANTHROPIC_API_KEY` (pay-per-token). A `claude login` subscription token
  would need interactive re-auth and a persisted `~/.claude`, so the API key
  is the v1 choice for unattended runs.
- **Codex:** deliberately NOT included in v1, per Keaton's instruction to
  stick to Claude Code for now. The pod is designed for it later: a second
  container sharing `/workspace`, with its own `CODEX_API_KEY` ExternalSecret
  entry and a `POST /v1/tasks` agent selector. See "Future work".

## Pre-merge checklist

- [ ] Create in Doppler: `MUSE_GATEWAY_TOKEN` (`openssl rand -hex 32`) and
      `ANTHROPIC_API_KEY`.
- [ ] Build + push the image, then pin it to a digest in
      `base/deployment.yaml`:
      `docker build -t ghcr.io/invertedorigin/muse-gateway:latest apps/muse-gateway/image`
      `docker push ghcr.io/invertedorigin/muse-gateway:latest`
      (No image-build CI exists in this repo yet; that is follow-up work.)
- [ ] Muse's cloud VM joins the tailnet as client `muse` (approved in the
      Tailscale admin console). Without that, nothing can reach the gateway.
- [ ] After first deploy, verify live: Tailscale proxy pod appears, the
      gateway answers at `http://muse-gateway.<tailnet>.ts.net:8080/healthz`,
      an unauthenticated `/v1/tasks` call is rejected, and the
      CiliumNetworkPolicy behaves as intended (it is marked draft in-code).
- [ ] `kustomize build apps/muse-gateway/overlays/apps` renders cleanly and
      passes the repo lint workflow.

## API (all /v1/* need `Authorization: Bearer <MUSE_GATEWAY_TOKEN>`)

| Endpoint | What it does |
| --- | --- |
| `GET /healthz` | Liveness, no auth |
| `POST /v1/tasks` | `{prompt, cwd?, allowedTools?, permissionMode?, timeoutMs?}` — one Claude Code task at a time (409 if busy). Default `permissionMode: acceptEdits`, scoped to `/workspace`; `bypassPermissions` is excluded. Returns Claude's JSON result (`result`, `session_id`, `total_cost_usd`) plus `duration_ms`. |
| `POST /v1/toolchain` | `{tool, args}` — `kubectl get/describe` (muse-gateway namespace only), `git status/log/diff`, `helm list/status`. No shell, no write operations in v1. |
| `GET /v1/secrets/:name` | Returns one secret's value, only if the name is in the `ALLOWED_SECRETS` allowlist in `base/configmap.yaml`. `gateway-token` and `anthropic-api-key` are hard-denied in code. Every retrieval is audit-logged (name + time, never the value). |

## Secrets allowlist — how to add one

1. Add the Doppler key (e.g. `HOMEASSISTANT_TOKEN`) to
   `base/external-secret.yaml`.
2. Add its secret name (e.g. `homeassistant-token`) to `ALLOWED_SECRETS` in
   `base/configmap.yaml`.
3. Both steps are required; either one alone changes nothing. The allowlist
   is empty by default, so nothing is retrievable until Keaton opts a secret in.

## What is NOT in v1 (deliberate)

- **Codex / other agents** — second container later, same pod, shared workspace.
- **Public Ingress** — Tailscale only. No Funnel, no `*.invertedorigin.com` host.
- **Write toolchain** — no `kubectl apply`, `helm upgrade`, pod exec, or
  cluster-wide reads. RBAC is a namespaced read-only Role. Writes are a
  separate, reviewed change.
- **ClusterRole / cross-namespace reads** — deferred; the gateway can only
  read its own namespace in v1.
- **VolSync backup of the workspace PVC** — follow the opencode backup
  pattern later if the workspace becomes worth backing up.
- **Image-build CI** — the Dockerfile is in-repo; publishing is manual until
  a GHCR workflow is added.
