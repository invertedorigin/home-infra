# ChatGPT desktop

This application runs the official ChatGPT desktop app for Linux inside a
browser-delivered Ubuntu XFCE desktop.

The desktop is available at `https://codex.invertedorigin.com`. Webtop adds a
login in front of the desktop with the username `codex` and the password read
from the Doppler key `CHATGPT_DESKTOP_PASSWORD`.

The first startup downloads the pinned ChatGPT package into the config PVC,
verifies its SHA-256 checksum, and installs it. Later pod restarts reuse the
cached package. Updating ChatGPT is an explicit change to the version, package
URL, and checksum in `base/bootstrap.yaml`.

Desktop state and the ChatGPT login are stored on the 20 Gi config PVC. Project
files should be kept under `/workspace`, which is backed by a separate 50 Gi
PVC.

