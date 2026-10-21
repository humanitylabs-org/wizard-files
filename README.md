# Wizard Files

Code-only private candidate. Approved Files interface, a new confined read-only engine,
and the existing Wizard resumable transfer client. No legacy content is copied.

## Boundary

The container has one owner-files read-only bind: `${ROOT_FOLDER_HOST}/media:/files:ro`,
plus app-owned derived cache storage `${APP_DATA_DIR}/data:/data`.
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

## Media gallery and photo sender contract

Photo/video cards lazily request small versioned thumbnails, never original media
bytes. One viewport-owned request runs at a time and cancels when its card leaves.
The installed app generates 480px JPEG previews on demand in isolated decoders
(two workers, 7-second wall/5-second CPU/768 MiB address-space ceilings, Pillow's
40-million-pixel safety limit). Over-budget/unsupported sources remain fully readable
through the original route and show a tappable fallback. No batch job or cron is used.
Derived cache storage is bounded to 64 MiB/1,024 files under app data, keyed by
path and exact device/inode/size/mtime/ctime. Every cache read first opens the original
through the same no-follow boundary. HTTP caching is private and versioned, with ETags;
mutable original URLs always revalidate. Browser frame memory is bounded to 96 entries;
existing device-cached video frames are preserved. Tapping thumbnail
or title immediately opens one muted player with native controls, fullscreen and
close/Back to the unchanged gallery. Unsupported codecs show a terminal fallback,
not an endless loading state. No thumbnail artifacts enter the owner's library.

The trusted photo producer may atomically replace `media/.wizard/photo-provenance.json`:
`{schema:1, owner_label:"Owner", agent_labels:{main:"Guide"}, files:[{path:"Photos/Chats/example.png", sha256:"<lowercase 64 hex>", sources:[{role:"user", agent_id:"main", sender_label:"Owner", thread_id:"thread", message_id:"message", sent_at:"2026-01-01T00:00:00Z"}]}]}`.
Multiple user/assistant sources are retained. Files reads that **one fixed hidden
path**, no-follow on every component, and verifies the SHA256 against the confined
regular photo bytes before trusting attribution. It never reads a history database,
attachment vault or another mount. Hidden metadata remains inaccessible to all public
file APIs. Missing/invalid metadata, missing files, symlinks and checksum mismatches
leave existing photos Other / unknown; nothing is inferred from names.

Reader limits: 8 MiB JSON, 10,000 entries, 128 agent labels, 512 sources per entry,
32 MiB per image and 128 MiB cold hashing per index request. Verified hashes cache
in process against device/inode/size/mtime/ctime; limits produce an explicit partial
attribution notice rather than false sender claims. The trusted producer owns privacy
eligibility and publication; Files only consumes already-projected owner-root bytes.
`api/index?type=photo&sender=owner|agent:<id>|unknown` combines with scope and search;
counts are before the sender filter, and latest verified sent time replaces import
mtime for sorting (path breaks ties). UI labels come from the manifest, never owner-specific code.

Index pages default to 120 items (`limit` 1–300, `offset` 0–10000); `has_more` and
`next_offset` describe the next page. Pass the returned `snapshot` with subsequent
pages: changed rows/order return `reset:true` and page zero, preventing gaps.
`truncated` describes only the bounded filesystem scan, not pagination. The view
loads more on demand, deduplicates paths and cancels old scope/filter/search requests.
Cold verification marks deferred photos pending, not Unknown; the view retries up
to eight bounded requests, then offers an explicit retry. Permanent size-limit or
checksum failures stay Unknown. Pagination is held until sender ordering stabilizes.

Loading, refreshing a saved view, preparing attribution, empty success, failure and
loading more are separate UI states. Sender controls stay usable during requests;
request generations/abort prevent stale results. Up to 12 exact scope/query/type/sender
views (1,200 rows each, 60-second reuse age) paint from memory, then validate in the
background. Visible views refresh every 30 seconds; changed snapshots reset pages.
No index/provenance server cache bypasses fresh file identity/hash checks.

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
REVISION=$(git rev-parse HEAD) -t wizard-files:0.1.4 .`. Run `python -m unittest discover
-s tests -v`; set `THUMBNAIL_REAL_TESTS=1` inside the Linux image for real decoder tests.
The image includes Pillow and FFmpeg for bounded previews. The shell supplies the real
`/wizard-os-home/core/app-client.js` (not bundled or reimplemented here).

Origin: the owner's approved Files styling and upload client. This repository is a
clean code-only fork, not the donor history. No media, catalogs, private sources,
identities or host-specific deployment configuration are distributed.

## Runtime packaging

`runtime.package: build` builds the pinned source locally: packaged Alpine
ffmpeg plus Pillow 11.3.0 wheels, never a compiler or an ffmpeg source build.
The official Python Alpine base uses a multi-architecture index digest.
`requirements.lock` carries universal hashes, including Python 3.12 musllinux
x86_64 and aarch64 wheels; `--require-hashes --only-binary=:all:` refuses
unhashed artifacts and compilation. Regenerate with:

```sh
uv pip compile requirements.txt --generate-hashes --universal --python-version 3.12 --no-header -o requirements.lock
```

App Manager names the local image; compose no longer selects a published image.
It runs as root with the existing dropped capabilities, no-new-privileges,
read-only filesystem and tmpfs. This allows thumbnail-cache writes to a clean
root-owned `/data` bind; owner-files remain mounted read-only.
Requires an App Manager release containing wizard-app-manager#153.
