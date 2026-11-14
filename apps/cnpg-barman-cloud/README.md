# CloudNativePG Barman Cloud plugin

Installs the [Barman Cloud CNPG-I plugin](https://cloudnative-pg.io/plugin-barman-cloud/)
into `cnpg-system`, using Docker Hardened Images for the plugin and the sidecar
it injects into Postgres pods. It replaces CloudNativePG's in-tree
`barmanObjectStore` backups, which are deprecated and removed in CNPG 1.32. The
plugin also lets Postgres run on images without `barman-cloud` (such as
`dhi.io/postgres`), because backups and WAL archiving happen in the sidecar.

## Using it from a Cluster

1. Add a `dhi-pull-secret` ExternalSecret in the Cluster's namespace and list it
   in `spec.imagePullSecrets`, so the injected sidecar can pull from `dhi.io`.
2. Translate `spec.backup.barmanObjectStore` into an `ObjectStore`
   (`spec.configuration`), moving `retentionPolicy` to the `ObjectStore`.
   Leave the `ObjectStore`'s own `serverName` empty.
3. In one change, replace `spec.backup` with a `plugins` entry
   (`isWALArchiver: true`) that sets `barmanObjectName` and, to continue an
   existing catalog, `serverName`. Switch `ScheduledBackup`s to
   `method: plugin` and convert `externalClusters` the same way.

`apps/teslamate` is the first consumer.

## Rollout order

Argo CD syncs each app independently. Merge this app first and wait for it to be
healthy before switching any Cluster to the plugin: the `ObjectStore` CRD must
exist, and a Cluster that references a plugin the operator cannot reach stops
archiving WAL.

```sh
kubectl -n cnpg-system rollout status deploy/barman-cloud-plugin-barman-cloud
kubectl -n cnpg-system get certificate barman-cloud-client barman-cloud-server
```

After switching a Cluster (this restarts its instances once):

```sh
# Sidecar injected and running
kubectl -n teslamate get pod teslamate-db-main-1 \
  -o jsonpath='{range .spec.initContainers[*]}{.name} {.image}{"\n"}{end}'
# WAL archiving healthy
kubectl -n teslamate get cluster teslamate-db-main \
  -o jsonpath='{.status.conditions[?(@.type=="ContinuousArchiving")]}'
# On-demand base backup through the plugin
kubectl -n teslamate create -f - <<'EOF'
apiVersion: postgresql.cnpg.io/v1
kind: Backup
metadata:
  generateName: teslamate-db-main-plugin-
spec:
  cluster:
    name: teslamate-db-main
  method: plugin
  pluginConfiguration:
    name: barman-cloud.cloudnative-pg.io
EOF
kubectl -n teslamate get backup --sort-by=.metadata.creationTimestamp
kubectl -n teslamate get objectstore teslamate-r2 -o jsonpath='{.status}'
```

## Updates

Renovate's `helm-values` manager tracks both digest-pinned image tags in
`valuesInline`. Keep the plugin and sidecar on the same version, and match the
chart's `appVersion`.
