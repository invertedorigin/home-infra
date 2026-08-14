# ChatGPT desktop

This application runs the official ChatGPT desktop app for Linux inside a
browser-delivered Ubuntu XFCE desktop.

The desktop is available at `https://codex.invertedorigin.com`. Authentication
is enforced by Cloudflare Access using mTLS and its user login flow; Webtop's
built-in HTTP Basic authentication is disabled.

The first startup downloads the pinned ChatGPT package into the config PVC,
verifies its SHA-256 checksum, and installs it. Later pod restarts reuse the
cached package. Updating ChatGPT is an explicit change to the version, package
URL, and checksum in `base/bootstrap.yaml`.

Desktop state and the ChatGPT login are stored on the 20 Gi config PVC. Project
files should be kept under `/workspace`, which is backed by a separate 50 Gi
PVC.

ChatGPT starts with Electron's `--no-sandbox` flag because its nested Chromium
sandbox cannot create a user namespace under Kubernetes' default seccomp
profile. The container retains the `RuntimeDefault` seccomp profile, SELinux
confinement, disabled privilege escalation, and no Kubernetes credentials.
Bootstrap also removes Chromium singleton lock files left behind by a previous
pod hostname before the desktop session starts.
