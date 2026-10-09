# Trivy Operator

The `core-infra` ApplicationSet discovers this app from its overlay and creates
`core-infra-trivy-operator`. The chart includes its CRDs; Argo CD applies them
with server-side apply. Renovate tracks the chart and explicit image pins.

## Coverage

This installation scans workload container images across all namespaces,
including `kube-system` and init containers. Reports include every severity and
findings without a fix. Only current workload revisions are scanned. Reports
expire after 24 hours and are recreated by the operator, allowing unchanged
images to be checked against new vulnerability data. Failed scans need attention;
an absent report does not mean an image has no vulnerabilities.

Configuration audits, exposed-secret scans, RBAC assessments, infrastructure
assessments, compliance scans, and stored SBOM reports are disabled. Scan jobs
use registry-based image scanning, with up to two jobs at once. The scanner
needs outbound access to image registries and vulnerability databases. Existing
workload image-pull credentials can be used for private images.

Completed scan jobs are deleted after their reports are saved. The operator
counts retained completed jobs against its concurrency limit, so setting a
scan-job retention period would stall the queue until those jobs expire.

Concurrency is currently limited while investigating disk stalls on the Talos
nodes. Increasing it to ten jobs coincided with continued etcd health failures;
slow disk flushes and API timeouts were already present at the lower limit.
Check storage latency as well as CPU and memory before increasing scan load.

Image findings do not establish complete Talos OS, Kubernetes advisory, or
Proxmox host coverage. Those need separate inventory and advisory checks. Mutable
image tags can change independently of deployed containers; digest-pinned
workload images provide reproducible targets.

## Inspect findings

After Argo CD syncs the app:

```sh
kubectl -n trivy-system rollout status deployment/trivy-operator
kubectl -n trivy-system logs deployment/trivy-operator --tail=100
kubectl get vulnerabilityreports -A
kubectl -n <workload-namespace> get vulnerabilityreport <report-name> -o yaml
```

Each detailed report contains the affected packages, vulnerability IDs,
installed versions, and fixed versions when available. The first scan can take
time while images and databases are downloaded. Reports are current-state
resources, not a persistent remediation history.

## Metrics and UI

The app includes the community
[Trivy Operator Dashboard](https://github.com/raoulx24/trivy-operator-dashboard)
alongside the operator. It reads VulnerabilityReports directly from Kubernetes;
no Prometheus, VictoriaMetrics, or Grafana backend is required. It lets you
browse reports, filter vulnerabilities, inspect packages and fixed versions,
and export findings. Other report modules are disabled to match the operator.

The dashboard's dedicated service account can only read namespaces and
VulnerabilityReports. Its image is pinned by version and digest for Renovate.
The deployment uses the configuration options and health probes from the
upstream 1.9.0 chart. History is disabled, so no database or persistent volume
is needed; this UI displays current findings.

Dashboard 1.9.0 starts its Prometheus endpoint even when OpenTelemetry is
disabled, which causes a missing `MeterProvider` startup exception. The local
metrics provider is enabled as a workaround, with no external telemetry
endpoint and no console exporter. This does not require a metrics backend.

After the Argo CD sync and certificate issuance, open
[the dashboard](https://trivy.invertedorigin.com). Its Cilium Ingress uses the
existing `cloudflare-issuer` and external-dns conventions, targeting
`ingress.home.arpa`. Access relies on the existing local-only ingress or
Cloudflare mTLS boundary; the dashboard has no built-in login.

Local port-forwarding is also available:

```sh
kubectl -n trivy-system rollout status deployment/trivy-operator-dashboard
kubectl -n trivy-system port-forward service/trivy-operator-dashboard 8900:8900
```

Open [the local dashboard](http://localhost:8900) while port-forwarding is running.
The default binding is localhost. If reports are not visible yet, inspect the
operator's scan jobs and logs using the commands above.

Trivy Operator itself has no web UI. Its separate Service exposes metrics at
`trivy-operator.trivy-system.svc:80/metrics`.

The cluster currently has Grafana but no ServiceMonitor or VMServiceScrape
CRDs, so this app does not create either resource. Connecting a metrics backend
later will allow Grafana trends using `trivy_image_vulnerabilities`. The official
[Grafana integration guide](https://aquasecurity.github.io/trivy-operator/latest/tutorials/grafana-dashboard/)
describes that integration.

## Validate the manifests

```sh
kustomize build --enable-helm apps/trivy-operator/overlays/core-infra
```
