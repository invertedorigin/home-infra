# WebRTC network diagnostics

This app establishes a real WebRTC data-channel connection from the browser to a
peer running in the cluster. In addition to the raw candidates and nominated
pair, it builds an evidence-based topology summary covering:

- browser and cluster host, mapped, and relay addresses;
- IPv4 and IPv6 availability;
- observed NAT port preservation or translation;
- cluster interface correlation and its configured link MTU;
- direct versus TURN-relayed data paths and round-trip timing;
- integrity-checked binary payload echoes from 1,200 bytes through 256 KiB;
- internal-address and mDNS privacy exposure;
- ICE gathering completion and timeout behavior; and
- browser reachability to each configured STUN and TURN transport.

The NAT summary intentionally does not label a network as cone, symmetric, or a
specific filtering type. A single ICE destination does not provide enough
evidence for that conclusion.

Browser WebRTC cannot perform classic IP path-MTU discovery because it does not
expose DF-bit control or ICMP Packet Too Big responses. Reliable SCTP can also
fragment a large data-channel message before sending it. The payload sweep is
therefore reported as application-path behavior, while the cluster interface MTU
is clearly labeled as a local configured value. TCP MSS is likewise unavailable
through browser socket APIs; the isolated TURN/TCP and TURN/TLS checks establish
transport reachability, not the negotiated MSS.

The page runs the automatic-path test when loaded. Use **Force TURN test** to
verify that a restrictive network can reach Cloudflare TURN even when direct ICE
paths are disabled. The configured-endpoints table shows every STUN, TURN/UDP,
TURN/TCP, and TURN/TLS URL returned with the short-lived credentials, including
the alternate port 53 endpoints. Each URL is tested in its own temporary browser
peer connection so a gathered candidate can be attributed to that endpoint.
These checks verify candidate gathering; **Force TURN test** remains the full
relayed data-channel check.

## Cloudflare TURN configuration

The `webrtc-diagnostics-turn` ExternalSecret reads these Doppler keys through the
cluster's `doppler-auth-api` ClusterSecretStore:

- `ANYTONE_CF_TURN_KEY_ID`
- `ANYTONE_CF_TURN_API_TOKEN`

They are the same names used by the AnyTone controller. The long-lived API token
is only available to the backend. Browsers receive short-lived credentials from
Cloudflare's `generate-ice-servers` endpoint.

When either key is unavailable, the app remains usable in STUN-only mode and
reports that TURN is not configured.

The credential endpoint must be protected from anonymous use. Put
`webrtc.invertedorigin.com` behind a Cloudflare Access policy before exposing it
publicly; anyone who can load the page can obtain the short-lived TURN credential
needed by WebRTC.

## Runtime

The WebRTC peer uses Pion and confines its host and server-reflexive ICE sockets
to UDP 50000–50099. The NetworkPolicy admits only that narrow range plus the HTTP
port; TURN connections remain normal pod egress.

The deployment uses an init container to compile the pinned Pion dependency into
an `emptyDir`. This keeps the GitOps app deployable without first publishing a
custom image, at the cost of requiring Go module access whenever the pod is
recreated.

For a fully immutable deployment, build `base/app/` into an image, remove the init
container, and change the main container image to that artifact.
