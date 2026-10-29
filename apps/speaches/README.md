# Speaches (Whisper API)

[Speaches](https://github.com/speaches-ai/speaches) provides the existing
OpenAI-compatible transcription and translation server, backed by faster-whisper.
The CPU image is pinned to `0.9.0-rc.3-cpu` and its published digest. This is an
upstream release candidate, the latest published release when added.

## Deployment

1. Add a strong `SPEACHES_API_KEY` to the Doppler configuration used by the
   `doppler-auth-api` ClusterSecretStore. External Secrets creates the
   `speaches-api-key` Secret; pods will wait for this required Secret.
2. Merge the app into the branch watched by Argo CD. The existing `apps`
   ApplicationSet discovers `apps/speaches/overlays/apps` automatically.
3. Check the rollout:

   ```sh
   kubectl -n speaches get externalsecret speaches-api-key
   kubectl -n speaches rollout status daemonset/speaches --timeout=30m
   kubectl -n speaches get pods -o wide
   kubectl -n speaches get endpointslices -l kubernetes.io/service-name=speaches
   ```

The DaemonSet runs one pod on each of `node-1`, `node-2`, and `node-3` and excludes
the USB worker. It tolerates the control-plane scheduling taint. Each pod requests
0.5 CPU and 1 GiB of memory, with limits of 4 CPUs and 4 GiB of memory. Increase
requests if sustained transcription needs reserved CPU capacity.

Each pod downloads `Systran/faster-whisper-small` before passing its startup and
readiness probes. The startup budget is 30 minutes to accommodate downloads.
Models load into memory on first use and remain loaded. All three nodes need
outbound access to Hugging Face for their initial downloads.

The Hugging Face cache is a separate disk-backed `emptyDir` per pod, limited to
8 GiB. It survives container restarts but is downloaded again after pod replacement
or a rollout. It uses no shared ReadWriteOnce volume or hostPath and needs no
backup. Change the volume configuration if persistent model caching is needed.

## Client configuration

- Base URL: `https://whisper.invertedorigin.com/v1`
- API key: the value stored as `SPEACHES_API_KEY`
- Model: `Systran/faster-whisper-small`
- In-cluster base URL: `http://speaches.speaches.svc.cluster.local:8000/v1`

Use the Hugging Face model ID in clients; OpenAI's `whisper-1` name is not the
configured model. API compatibility does not mean identical model names or output.

With the key available in your shell as `SPEACHES_API_KEY`:

```sh
curl --fail-with-body --max-time 3600 \
  https://whisper.invertedorigin.com/v1/audio/transcriptions \
  -H "Authorization: Bearer ${SPEACHES_API_KEY}" \
  -F file=@recording.m4a \
  -F model=Systran/faster-whisper-small \
  -F response_format=json
```

The ingress also exposes `/v1/audio/translations` and read-only model discovery at
`/v1/models`. The web UI is disabled; the ingress does not expose health checks,
model administration, or other Speaches features. TLS and DNS use the existing
`cloudflare-issuer` and external-dns conventions. Restart the DaemonSet after API
key rotation because its environment is read at process startup.

## Request distribution and tuning

Cilium's ingress Envoy balances HTTP requests across the ready Service endpoints
using round robin, including requests from a client that reuses its connection.
The Service has no session affinity and permits cross-node traffic. No additional
proxy or custom API server is required. See the
[Cilium 1.20.2 cluster configuration](https://github.com/cilium/cilium/blob/v1.20.2/operator/pkg/model/translation/envoy_cluster.go)
for the ingress `ROUND_ROBIN` policy.

Each Envoy instance has its own balancing state, so there is no single global
node-1/node-2/node-3 sequence. Unready endpoints are removed. Round robin spreads
request counts; varying recording lengths can still produce uneven CPU load.
Calls directly to the ClusterIP use the cluster's Service balancing behavior;
use the ingress URL for HTTP request balancing.

The ingress request timeout is one hour using Cilium's supported annotation.
Client timeouts and any intermediary or Envoy idle timeouts can still end long
requests sooner. There is no NGINX-specific upload-size setting because this
cluster uses Cilium. Validate representative recording sizes after deployment.

CPU inference uses int8, four threads, and one inference worker per pod. These are
starting values for the mini PCs, not a measured performance guarantee. Adjust
`WHISPER__CPU_THREADS`, resource limits, and `PRELOAD_MODELS` in `base/daemonset.yaml`
to tune throughput and model quality. The selected small model is multilingual;
larger models require more RAM and CPU. Use the same model ID in clients and in
`PRELOAD_MODELS` so every backend caches it before serving requests. Other model
IDs can trigger downloads independently on whichever backend receives a request.

Configuration and cache behavior follow the pinned release's
[settings](https://github.com/speaches-ai/speaches/blob/v0.9.0-rc.3/src/speaches/config.py)
and [startup code](https://github.com/speaches-ai/speaches/blob/v0.9.0-rc.3/src/speaches/main.py).

## Local validation

```sh
kustomize build apps/speaches/base
kustomize build apps/speaches/overlays/apps
```

After rollout, verify an unauthenticated transcription request is rejected and an
authenticated request with real audio succeeds. Send several recordings and inspect
each pod's logs to confirm traffic reaches all three nodes. Local manifest checks
cannot establish real transcription performance or live ingress distribution.
