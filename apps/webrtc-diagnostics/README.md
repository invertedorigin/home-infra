# WebRTC path diagnostics

This app establishes a real WebRTC data-channel connection from the browser to a
peer running in the cluster. It shows every gathered ICE candidate and the
nominated candidate pair, which distinguishes a direct/STUN-assisted path from a
Cloudflare TURN relay.

The page runs the automatic-path test when loaded. Use **Force TURN test** to
verify that a restrictive network can reach Cloudflare TURN even when direct ICE
paths are disabled.

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
