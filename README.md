# Wizard Files

Code-only private candidate. Approved Files interface, a new confined read-only engine,
and the existing Wizard resumable transfer client. No legacy content is copied.

## Boundary

The container has one read-only bind: `${ROOT_FOLDER_HOST}/media:/files:ro`.
It runs as UID 1000 with no capabilities, a read-only image, no app database, no host
service credentials, no Docker socket and no legacy or agent-home mounts. Every read
uses an anchored root descriptor and `openat` (`dir_fd`) with `O_NOFOLLOW` on every
component, rejecting even internal symlinks. Hidden files and non-regular files are
excluded. Static serving is an explicit asset allowlist. Owner HTML/SVG is downloaded,
not served as active same-origin code. Search returns filenames only, not contents.

Uploads are not proxied or reimplemented by this container. The view uses the system
`/wizard/v1/uploads` endpoint and verifies the completed file through this reader.
The installer must configure that system service's owner-files root to the same media
root. Shared-origin apps retain the host shell's authority boundary; this package does
not claim to isolate a malicious same-origin app from the system API.

## Install

Install the private source through WAM. Configure FILES_ALLOWED_HOSTS to the hostnames
of the authenticated Wizard gateway, comma separated (no schemes). Publish no raw
container port externally. The initial staged package intentionally has no `provides`
slot; canonical activation is a separate reviewed metadata step.

Build on the designated worker: `docker build --platform linux/amd64 --build-arg
REVISION=$(git rev-parse HEAD) -t wizard-files:0.1.0 .`. Run `python -m unittest discover
-s tests -v`. Runtime has no third-party dependencies. The shell supplies the real
`/wizard-os-home/core/app-client.js` (not bundled or reimplemented here).

Origin: the owner's approved Files styling and upload client. This repository is a
clean code-only fork, not the donor history. No media, catalogs, private sources,
identities or host-specific deployment configuration are distributed.
