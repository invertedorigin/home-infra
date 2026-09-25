# Talos configuration

Each file in `nodes/` contains the complete set of configuration overrides
for one machine, using Talos 1.14's multi-document format. The task targets
Talos 1.14.1 for base generation and validates every patched node config.
The factory installer image is pinned to v1.14.1 as well.

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
Talos 1.14's newly generated workload isolation, weekly filesystem trim, and
secure EPHEMERAL mount documents are removed by each node override for the
initial configuration migration. Adopt those features separately after review.
`talosctl apply-config --dry-run` can print secrets in its raw config diff;
keep that output private.

Keep the existing values in Doppler: they preserve the cluster identity. Do not
run `talosctl gen secrets` for this existing cluster.

## Routed ingress pilot

The control-plane files in `nodes/` now include Talos 1.14 native BGP. Each
node's `workload` instance waits for Cilium across an isolated veth/VRF; its
`fabric` instance imports only Service VIPs inside `10.246.0.0/27` and peers
with the UDM Pro at `10.0.1.1`. All three fabric sessions established with
zero routes exchanged before enabling Cilium BGP. Each node explicitly runs
DHCPv4 on `ens18`: adding the veth disables Talos's automatic DHCP on physical
links, so do not remove `DHCPv4Config` without an alternative LAN address.

`cni/values.yaml` enables the Cilium BGP control plane. Its CRDs and agents
were verified before adding `cni/bgp-ingress.yaml` to `cni/kustomization.yaml`
for the next Argo CD sync. That manifest allocates only from `10.246.0.0/27`
to explicitly labelled Services.
The existing `10.0.1.5-9` L2 pool, L2 policy, and Talos API VIP at
`10.0.1.10` remain unchanged.

Pilot values:

| Purpose | Draft value |
| --- | --- |
| Routed ingress pool | `10.246.0.0/27` (`.1` through `.30` allocatable) |
| UDM Pro peer | `10.0.1.1`, ASN `64512` |
| Talos fabric ASN | `64513` on each node |
| Talos workload ASN | `64514` on each node |
| Cilium ASN | `64515` on each node |
| Local veth pair | `fd46:494f:100::/127`, reused independently on each node |

`udm-pro-bgp.conf` is the UniFi/FRR reference for the peer and prefix policy.
The established sessions verify the peer IPs and ASNs, not yet the UDM's
prefix filter or ECMP behavior. Before introducing a test VIP, confirm the
CIDR has no VLAN, route, VPN, or DHCP use, that the UDM accepts only /32 VIPs
within it, and that its forwarding table can install up to three equal-cost
paths. Keep Cilium's VXLAN routing mode for this phase.

The shared `cilium-ingress` Service is the first routed Service. Cilium
redirects a Service to Envoy by its name, and a second Service can't use the
shared listener. So `cni/cilium-ingress-service-patch.yaml` gives the one
Service two VIPs: `lbipam.cilium.io/ips: 10.0.1.7,10.246.0.1` plus the
`bgp-ingress` label. Every Ingress then answers on both addresses. Keep both
IPs in the annotation: LB-IPAM releases any allocation it doesn't list.
Side effects of the shared label and nil `loadBalancerClass`:

- Cilium also advertises `10.0.1.7/32` to the Talos workload peer. It stays in
  `vrf-cilium` because the fabric instance imports only `10.246.0.0/27`.
- `l2policy` also answers ARP for `10.246.0.1` on `ens18`. That's harmless
  because the address is off-subnet.
- `ingress.home.arpa` is pinned to `10.0.1.7` with the external-dns `target`
  annotation. Remove it, or point it at `10.246.0.1`, to move clients to the
  routed path.

Test with
`curl --resolve grafana.invertedorigin.com:443:10.246.0.1 https://grafana.invertedorigin.com`.
For a three-next-hop ECMP test, use `externalTrafficPolicy: Cluster` or run a
ready local backend on all three nodes with `externalTrafficPolicy: Local`;
otherwise Cilium may correctly advertise from only a subset of nodes.
