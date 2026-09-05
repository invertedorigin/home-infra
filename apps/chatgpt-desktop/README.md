# ChatGPT desktop

This application runs the official ChatGPT desktop app for Linux inside a
browser-delivered Ubuntu XFCE desktop.

The desktop is available at `https://codex.invertedorigin.com`. Authentication
is enforced by Cloudflare Access using mTLS and its user login flow; Webtop's
built-in HTTP Basic authentication is disabled.

The first startup downloads the pinned ChatGPT package into the config PVC,
verifies its SHA-256 checksum, and installs it. Later pod restarts reuse the
cached package. Renovate tracks OpenAI's stable Linux amd64 package index and
opens updates to the version and matching SHA-256 checksum together in
`base/bootstrap.yaml`; the package URL is derived from that version. Keep the
two assignments adjacent so Renovate can update them as one dependency. The
custom datasource in `renovate.json` ignores entries without a valid checksum.
Updates follow the repository's existing PR and automerge policy. After merging,
restart the desktop pod to install the new version; changing this ConfigMap alone
does not trigger a Deployment rollout.

Desktop state and the ChatGPT login are stored on the 20 Gi config PVC. Project
files should be kept under `/workspace`, which is backed by a separate 50 Gi
PVC.

GitHub authentication is supplied by the `CHATGPT_GITHUB_TOKEN` Doppler secret.
External Secrets exposes it to the desktop as `GH_TOKEN`; the bootstrap installs
GitHub CLI and configures Git to use its credential helper. The token should be
fine-grained, limited to this repository, and granted only Contents and Pull
requests read/write permissions.

ChatGPT starts with Electron's `--no-sandbox` flag because its nested Chromium
sandbox cannot create a user namespace under Kubernetes' default seccomp
profile. The container retains the `RuntimeDefault` seccomp profile, SELinux
confinement and disabled privilege escalation. Bootstrap also removes Chromium
singleton lock files left behind by a previous pod hostname before the desktop
session starts.

Webtop's virtual display is capped at 5120x2880 to avoid allocating its default
16K framebuffer. Multi-screen and session-sharing features are disabled. The
pod liveness check covers Webtop, ChatGPT, and the bundled Codex app server, so
the desktop is restarted if the automatically launched application exits and
does not recover.

The desktop includes pinned, checksum-verified versions of `kubectl` and `k9s`.
They use a rotating projected token from the `chatgpt-desktop-viewer` service
account, which is bound cluster-wide to Kubernetes' built-in `view` role. This
allows resource discovery and pod logs but not Secrets, exec, or mutations.
