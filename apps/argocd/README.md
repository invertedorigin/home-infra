# Argo CD

The core-infra overlay renders Docker's `oci://dhi.io/argocd-chart` through
Kustomize. Chart 10.10.1 supplies Argo CD 3.5.4 and Redis 8.10.2, with its
own digest-pinned hardened images and compatible runtime configuration.

The existing Git-backed Argo CD Application continues managing the deployment.
The overlay retains the ingress, root Application, repository Secret, namespace,
locked-down default project, and existing metrics services. Dex is disabled;
local Argo CD accounts and the existing external ingress security remain in use.

## Registry credentials

The `dhi-pull-secret` ExternalSecret reads `DHI_USERNAME` and `DHI_PULL_TOKEN`
from the Doppler-backed `doppler-auth-api` ClusterSecretStore. It creates an
`argocd/dhi-pull-secret` Secret of type `kubernetes.io/dockerconfigjson`, refreshed
hourly. The chart references it for workload image pulls.

The repo server also mounts this Secret as `/app/config/dhi/config.json` and sets
`HELM_REGISTRY_CONFIG` to that path. Kustomize invokes Helm directly when
rendering the private OCI chart, so its registry credentials must be available
inside the repo server independently of Kubernetes image pulls. Projected Secret
updates make refreshed credentials available without putting tokens in Git.

For the initial migration from the original cluster-install deployment, seed
this mount **before** the first chart sync, once the ExternalSecret is ready:

```sh
kubectl -n argocd patch deployment argocd-repo-server \
  --type=strategic --patch-file apps/argocd/bootstrap-registry-patch.yaml
kubectl -n argocd rollout status deployment/argocd-repo-server
```

This patch targets the original repo server's container name and is only for
that initial migration. Afterward, `values.yaml` maintains the configuration.

Hosted Renovate needs credentials separately. In the repository's settings at
<https://developer.mend.io>, add these Credentials secrets:

- `DHI_USERNAME`: Docker Hub username.
- `DHI_RENOVATE_TOKEN`: read-only Docker personal access token.

The `dhi.io` Docker host rule in `renovate.json` references these Mend secrets;
no token values belong in Git.

## Migration and updates

The chart uses its native workload and Service selectors. When migrating from
the original cluster-install manifests, the application controller, repo server,
server, ApplicationSet controller, and notifications controller must be deleted
and recreated once: their workload selectors are immutable. Pause the `argocd`
Application's automated sync during this controlled migration, publish the chart
configuration, recreate those workloads from the rendered chart, then restore
automated sync. Retain the namespace, CRDs, Applications, and Secrets. Redis can
update in place. Subsequent chart upgrades use normal updates unless an immutable
field changes again.

The controller metrics Service retains the existing `argocd-metrics` name.

The chart renders `argocd-secret` and `argocd-notifications-secret` without data
overrides, retaining existing credentials. Its Redis initialization hook reuses
the existing `argocd-redis` authentication Secret. Argo CD CRDs retain the
server-side apply annotation needed for their size.

Renovate's native Kustomize manager tracks `dhi.io/argocd-chart` versions through
the Docker datasource. Chart upgrades require review and carry the vendor's
Argo CD and Redis image selections together. Kustomize's chart integration does
not pin or track OCI chart digest changes; a rebuild under the same chart tag
will not create a Renovate digest PR. Check the publisher's chart and image
changes when reviewing upgrades.

To render locally, authenticate Helm and explicitly retain its registry config
path because Kustomize creates its own Helm configuration directories:

```sh
helm registry login dhi.io
HELM_REGISTRY_CONFIG="$(helm env HELM_REGISTRY_CONFIG | tr -d '\"')" \
  kustomize build --enable-helm apps/argocd/overlays/core-infra
```

Hardened images can still produce vulnerability findings. Docker publishes
[VEX statements](https://docs.docker.com/dhi/how-to/scan/) for its images; this
configuration does not enable VEX filtering in Trivy Operator.
