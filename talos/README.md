# Talos configuration

Each file in `nodes/` contains the complete set of configuration overrides
for one machine. These files currently target the Talos 1.13.10 configuration
contract so the talhelper removal can be compared with the running cluster
before changing the Talos version. The installer image remains at v1.13.8 to
match the live machine configuration; updating it belongs to the later
upgrade step.

`secrets.yaml.tmpl` maps the existing Doppler values into a native Talos
secrets bundle. The Talos task renders it in a private temporary directory,
generates the Talos base configs, applies each node's file, and validates the
results. The task also pins the cluster endpoint and component versions.

Run the repository task to regenerate the ignored `clusterconfig/` directory:

```sh
task talos:genconfig
```

Generated configs in `clusterconfig/` are ignored by Git and contain secrets.
Review changes in `nodes/`; regenerate rather than editing the outputs.

Keep the existing values in Doppler: they preserve the cluster identity. Do not
run `talosctl gen secrets` for this existing cluster.
