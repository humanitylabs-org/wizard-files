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
container port externally. This managed package provides the files slot; legacy
catalogs remain separate and are not migrated.

### Personal files and app data

Your files is the default view. Set `FILES_APP_DATA_PREFIXES` to a JSON array of
explicit relative file or directory paths owned by apps (portable default: `[]`).
For example, `["ExampleLibrary", "ExampleRecorder/manifest.json"]` separates a whole
library and one metadata file while retaining recordings in Your files. Unknown
files always remain visible. There are no filename, extension or AI-title guesses.
The install owner must verify ownership before configuring a prefix.

App data is opt-in and browse/download only. Both scopes apply to folder listings,
Recent, search, categories and counts, including MCP (`scope: personal|app`). App
scope traverses only matching paths and their ancestors; personal scope skips
classified subtrees. Overlapping prefixes do not duplicate files. Empty, absolute,
hidden, escaping, malformed or excessive prefixes stop startup instead of hiding
unrelated data. Changing this policy never moves or deletes files.

This is visibility separation, not new authorization: same-root content and download
URLs retain their existing read boundary. Private agent stores are never mounted.
Uploads still use the shared resumable endpoint; this UI checks the current policy
before starting or resuming any job and refuses app-data destinations. The independent
transfer service's authorization is unchanged. Root uploads use the existing Inbox
behavior; if any Inbox prefix is classified, choose a different personal folder.

Build on the designated worker: `docker build --platform linux/amd64 --build-arg
REVISION=$(git rev-parse HEAD) -t wizard-files:0.1.1 .`. Run `python -m unittest discover
-s tests -v`. Runtime has no third-party dependencies. The shell supplies the real
`/wizard-os-home/core/app-client.js` (not bundled or reimplemented here).

Origin: the owner's approved Files styling and upload client. This repository is a
clean code-only fork, not the donor history. No media, catalogs, private sources,
identities or host-specific deployment configuration are distributed.
