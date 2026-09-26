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
The existing `10.0.1.5-9` L2 pool and L2 policy remain unchanged.

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

The shared `cilium-ingress` Service is routed-only. Cilium redirects a
Service to Envoy by its name, so there is one ingress Service for every
Ingress. `cni/cilium-ingress-service-patch.yaml` gives it the `bgp-ingress`
label and pins `lbipam.cilium.io/ips: 10.246.0.1`. The pin matters because the
L2 `pool` has no Service selector: without it, LB-IPAM could also allocate a
`10.0.1.x` address. external-dns publishes `ingress.home.arpa` as
`10.246.0.1`. `l2policy` still answers ARP for `10.246.0.1` on `ens18`,
because the Service's `loadBalancerClass` is nil and can't be changed. That's
harmless: the address is off-subnet.
The Tailscale subnet routers in `apps/tailscale-operator` advertise
`10.246.0.0/27` so tailnet clients can reach it.

Test with
`curl --resolve grafana.invertedorigin.com:443:10.246.0.1 https://grafana.invertedorigin.com`.

Clients on `10.0.1.0/24` reach a routed VIP through the UDM. Without a policy
rule, the node replies straight to them on-link. The UDM sees only half the
flow and drops the client's ACK as invalid: the TCP handshake completes, then
the connection hangs. Each control-plane node therefore has a
`RoutingRuleConfig`, `from 10.246.0.0/27 to 10.0.1.0/24 lookup 89`, plus a
`LinkConfig` default route via `10.0.1.1` in table 89, so replies return
through the UDM. The nodes ignore ICMP redirects, because
`net.ipv4.conf.all.accept_redirects` is 0. The UDM still sends same-subnet
clients a redirect to the node, and clients that obey it will hang: most Linux
and Windows hosts do by default, macOS doesn't. Turning off `send_redirects` on
the UDM's LAN bridge fixes that. Ping doesn't work as a test: Cilium
doesn't answer ICMP on LB VIPs. Anything Cilium doesn't handle itself, such as
ICMP, falls through to the kernel. Without a `BlackholeRouteConfig` for
`10.246.0.0/27`, the node forwards it back to the UDM, which routes it to the
node again until the TTL expires. The blackhole drops it on the first hop.
## Routed API VIP

`10.246.0.32` is the Kubernetes API VIP. The cluster endpoint is
`https://k8s.home.arpa:6443`: a `DNSEndpoint` in `apps/kube-vip` has
external-dns publish that name to the UDM, pointing at the VIP. The old Layer
2 VIP `10.0.1.10` is gone; it stays in `certExtraSANs` until no kubeconfig
uses it. Node IPs are also in the API certificates, so
`https://<node-ip>:6443` works as break-glass access. The kubelet and Cilium
use KubePrism (`127.0.0.1:7445`), which also lists `localhost` and the node
IPs, so a cold start never waits on the VIP or DNS. Each control-plane node
has an empty `dummy-api` link, and its `fabric` BGP instance advertises
whatever that link carries (`advertise: [dummy-api]`, the equivalent of
`redistribute connected`). kube-vip (`apps/kube-vip`) runs on every
control-plane node in routing-table mode without leader election, with its own
ARP and BGP off. Every 2 s it checks the local
`https://127.0.0.1:6443/readyz`. It holds `10.246.0.32/32` on `dummy-api` while
the check passes and deletes it on the first failure. The UDM therefore
load-balances across every node with a ready apiserver, and a node leaves the
ECMP set within a check interval of its apiserver failing or starting a
graceful shutdown. The BGP sessions stay up throughout. kube-vip reaches the
API itself through KubePrism (`127.0.0.1:7445`), so it keeps running while the
local apiserver is down. Routing-table mode also writes the `/32` into table
198, which nothing reads.

Supporting changes: the return-path rule and the blackhole route cover
`10.246.0.0/26`, the UDM prefix list and the Tailscale routes accept `/26`,
and Cilium pins `devices: ens18`. Without that pin, Cilium auto-detection
would adopt `dummy-api` whenever it holds the VIP, because Cilium counts
routes in every table, and the datapath would reload each time the VIP is
added or removed.

For a three-next-hop ECMP test, use `externalTrafficPolicy: Cluster` or run a
ready local backend on all three nodes with `externalTrafficPolicy: Local`;
otherwise Cilium may correctly advertise from only a subset of nodes.
