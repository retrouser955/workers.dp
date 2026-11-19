# workers.dp

A Discord Player v8 playback backend that runs each guild's voice connection,
audio decoding, filtering, and playback inside Node.js worker threads.

- GitHub: [retrouser955/workers.dp](https://github.com/retrouser955/workers.dp)
- Built for [`discord-player`](https://discord-player.js.org) `8.0.0-dev.10`
- Uses [`@discordjs/voice`](https://github.com/discordjs/voice) for voice transport
- Uses [`mediabunny`](https://mediabunny.dev) and `node-av` for decoding and libav filtering
- Uses `@discord-player/opus` + `mediaplex` for Opus encoding

> **Status:** this package is not published to npm. Install it from a tarball as
> described below. Crossfade/staging and remote plugin-host operation sources
> are not implemented yet.

## Features

- One worker thread owns a configurable number of guilds.
- Per-guild Discord voice connection and `AudioPlayer` inside the worker.
- Grow or fixed worker pools, with idle-worker reaping in grow mode.
- Main-thread extractor queries and worker-side stream resolution.
- `url`, `file`, and `buffer` playback sources.
- Extractor `Readable` streams are resolved and consumed inside the worker.
- libav filter graphs, including volume via a filter stage.
- Gateway voice payload relay through Discord Player's `send` callback.
- Discord Player queue/session lifecycle through a `PlaybackSession` proxy.

## Requirements

- **Node.js 20.3+**, tested on Node.js 24.
- **`discord-player` `^8.0.0-dev.10`** installed in your bot.
- A platform with binaries available for `node-av`, `@mediabunny/server`, and
  `mediaplex`. Prebuilts exist for Windows x64, macOS, and common Linux targets;
  verify your OS/CPU combination before deploying.
- Extractor packages compatible with the same `discord-player` version your bot
  uses.

No system FFmpeg binary is required. Decoding and filtering use `node-av`.

## Install from a tarball

`workers.dp` is consumed as a local package. Do **not** use
`yarn add file:../workers.dp` with Yarn 1: it copies the package's
`node_modules` into your bot, which can create a second `discord-player` copy
and break `BaseExtractor` identity checks.

Use `yarn pack` instead.

### 1. Build and pack

```bash
cd /path/to/workers.dp
yarn install
yarn build
yarn pack
```

This creates a tarball whose name follows `package.json`, for example:

```text
workers.dp-v1.0.3.tgz
```

If you change the code, bump `version` in `package.json` before packing again.
Yarn may reuse a cached tarball when the package name and version are unchanged.

### 2. Install in your bot

```bash
cd /path/to/my-bot
yarn add ../workers.dp/workers.dp-v1.0.3.tgz
```

With npm:

```bash
npm install ../workers.dp/workers.dp-v1.0.3.tgz
```

### 3. Update an existing install

```bash
# after editing and bumping the version in workers.dp/package.json
cd /path/to/workers.dp
yarn build
yarn pack

cd /path/to/my-bot
yarn remove workers.dp
yarn add ../workers.dp/workers.dp-v1.0.4.tgz
```

If the new version is not picked up, remove `node_modules/workers.dp` first or
run `yarn cache clean workers.dp`.

## Quick start

Install `discord-player` in the bot if it is not already present:

```bash
yarn add discord-player@^8.0.0-dev.10
```

### 1. Create a source module

The same module is loaded by the main thread for searching and by every worker
for stream resolution.

`sources.mjs`:

```js
import { SpotifyExtractor } from "discord-player-spotify";
import { YoutubeExtractor } from "discord-player-youtubei";

/**
 * @param {import("workers.dp").SourceRuntime} runtime
 * @param {unknown} options
 */
export async function registerSources(runtime, options) {
    // Legacy extractors.
    await runtime.extractors.register(SpotifyExtractor, {});
    await runtime.extractors.register(YoutubeExtractor, {});
}
```

Modern source plugins are registered through the plugin registry. `definePlugin`
returns a factory, so call it:

```js
import { definePlugin } from "discord-player";

const myPlugin = definePlugin({
    id: "my.source",
    setup(ctx) {
        ctx.on("search.query.match", async ({ query }) => {
            return query.startsWith("my:") ? { score: 100 } : null;
        });

        ctx.on("search.query.resolve", async ({ query }) => {
            // Return { tracks, playlist }.
        });

        ctx.on("track.stream", async ({ track }) => {
            // Return a URL, file, buffer, or Readable.
        });
    }
});

export async function registerSources(runtime, options) {
    await runtime.plugins.register(myPlugin(options));
}
```

`registerSources` must `await` every registration. Providers registered after
setup has finished will not receive a worker `track.stream` proxy.

The module must be JavaScript or ESM that Node can execute. It is not compiled
from TypeScript. It is loaded separately in the main process and in each worker,
so do not share mutable process-local state between them. Read credentials from
environment variables or the module's own configuration rather than relying on
objects copied between threads.

### 2. Create the Player

`src/player.ts`:

```ts
import { Events } from "discord.js";
import { Player } from "discord-player";
import { workerPlugin } from "workers.dp";
import { client } from "./client.js";

export const player = new Player({
    send(guildId, payload) {
        const shard = client.guilds.cache.get(guildId)?.shard;
        return shard ? shard.send(payload) : false;
    },
    plugins: [
        workerPlugin({
            // Pass a URL object, not a file: URL string.
            workerScript: new URL(import.meta.resolve("workers.dp/worker")),
            mode: {
                type: "grow",
                guildPerWorker: 8
            },
            sources: {
                module: new URL("../sources.mjs", import.meta.url).href,
                resolveTimeoutMs: 30_000
            }
        })
    ]
});

await player.initialize(process.env.DISCORD_CLIENT_ID!);

// Feed Discord Gateway dispatches to Discord Player.
client.on(Events.Raw, (packet) => player.receive(packet));
```

CommonJS hosts can resolve the worker entry with `require.resolve`:

```js
const { createRequire } = require("node:module");
const requireFromHere = createRequire(__filename);

workerScript: requireFromHere.resolve("workers.dp/worker")
```

### 3. Search and play

```ts
const result = await player.search(query, {
    requestedBy: interaction.user.id
});

const track = result.tracks[0];
if (!track) {
    await interaction.editReply("No matching track found.");
    return;
}

const channel = interaction.member?.voice.channel;
if (!channel) {
    await interaction.editReply("Join a voice channel first.");
    return;
}

await player.play(channel, track, {
    nodeOptions: {
        metadata: {
            channel: interaction.channel
        }
    }
});
```

## How it works

```text
Discord Gateway
      │
      ▼
Player.receive()
      │
      ▼
WorkerBackend ──► WorkerManager
                       │
                       ├─ Worker A ──► guild 1
                       │              guild 2
                       │
                       └─ Worker B ──► guild 3
```

Each worker owns:

```text
VoiceConnection
AudioPlayer
SourceRuntime (stream resolution)
mediabunny decoder
libav filter graph
OpusEncoder (mediaplex)
```

### Extractor split

A Node `Readable` cannot cross a worker `postMessage` boundary. The backend
therefore splits the source host:

```text
Main thread
  SourceRuntime
    search.query.match
    search.query.resolve

Worker
  SourceRuntime
    track.stream
    track.bridge
    media/stream transforms
```

The main thread registers one provider-scoped `track.stream` proxy per
registered provider. The proxy returns an internal URL token:

```text
workers.dp:source:<base64url>
```

The worker decodes the token, restores the `Track`, and resolves the actual
stream locally. The serialized track contains public metadata and, when
JSON-safe and under 256 KiB, the legacy `raw` payload. Tokens larger than
512 KiB are rejected.

This means extractors are registered twice: once on the main thread for search
and once in every worker for streaming. Cookies, caches, and rate limits are
therefore per worker and are not shared with the main query host.

### Supported playback sources

| Source | Main thread → worker | Worker-side extractor |
| --- | --- | --- |
| `{ url }` | Yes | Yes |
| `{ file }` | Yes | Yes |
| `{ buffer }` | Yes, copied | Yes |
| `{ stream }` | No | Yes, consumed locally |
| `{ operation }` | No | No |

`PlaybackBackend.capabilities` declares `["url", "file", "buffer"]`,
`filters: true`, and `crossfade: false`.

## Options

### `workerPlugin(options)`

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `mode` | `WorkerMode` | required | `{ type: "grow", guildPerWorker }` or `{ type: "fixed", workers }` |
| `workerScript` | `string \| URL` | required | Built worker entry, usually `new URL(import.meta.resolve("workers.dp/worker"))` |
| `sources` | `WorkerSourceOptions` | none | Source module and runtime settings |
| `requestTimeoutMs` | `number` | `30000` | Deadline for session requests to a worker |
| `connectTimeoutMs` | `number` | `15000` | Deadline for voice connections |
| `maxRespawns` | `number` | `10` | Global worker respawn budget |
| `workerData` | `unknown` | none | Data passed to workers; custom worker entries may consume it |

When `sources` is configured, `workerData` is wrapped as
`{ __workersDpSources: { sources, userData: workerData } }` before it reaches
the worker. The bundled worker ignores `userData`; it exists for custom worker
entries.

### `sources`

| Option | Type | Description |
| --- | --- | --- |
| `module` | `string` | Module exporting `registerSources(runtime, options)` |
| `options` | `unknown` | Structured-cloneable options passed to `registerSources` |
| `blockExtractors` | `string[]` | Provider IDs disabled in both hosts |
| `probeTimeout` | `number` | Compatibility hint forwarded to extractors |
| `resolveTimeoutMs` | `number` | Deadline for source-runtime startup, `track.stream`, and transforms (default `30000`) |

`module` may be:

- an absolute path,
- a path relative to `process.cwd()`,
- a `file:` URL,
- a package specifier.

### `SourceRuntime`

The runtime passed to `registerSources` exposes:

```ts
runtime.plugins      // PluginRegistry
runtime.extractors   // ExtractorExecutionContext
runtime.options      // SourceRuntimeOptions
runtime.search(...)  // SearchResult
runtime.match(...)   // SourceMatch[]
runtime.destroy()    // Promise<void>
```

## Worker modes

### Grow

```ts
mode: { type: "grow", guildPerWorker: 8 }
```

- Starts with no workers.
- Assigns to the least-loaded worker below `guildPerWorker`.
- Spawns a new worker only when every worker is full.
- Reaps a worker after **30 seconds** with no guilds.
- Can scale down to zero workers.
- Does not consolidate partially loaded workers; a worker with one guild stays.

### Fixed

```ts
mode: { type: "fixed", workers: 4 }
```

- Spawns the configured number of workers immediately.
- Assigns guilds round-robin.
- Does not reap idle workers.
- Respawning replaced workers that owned guilds, until the global
  `maxRespawns` budget is exhausted. An empty worker that exits is not
  automatically replaced.

## Timeouts and teardown

| Operation | Deadline |
| --- | --- |
| Session request | `requestTimeoutMs` (30 s) |
| Voice connect | `connectTimeoutMs` (15 s) |
| Source runtime + stream resolution | `resolveTimeoutMs` (30 s) |
| Audio probe | 15 s |
| Guild teardown lock | 2 s |
| Idle worker reap | 30 s |

`stop()`, `disconnect()`, and `destroy()` abort the active source resolution
and probe before waiting for the guild lock. If the lock still cannot be
acquired within two seconds, teardown proceeds best-effort and the aborted play
unwinds later.

Idle-worker shutdown uses `Worker.terminate()`, which Node reports as exit code
`1`. The manager marks those workers as intentionally terminated, so the
backend does not log them as crashes.

## Known limitations

- **Crossfade/staging is not implemented.** `capabilities.crossfade` is `false`.
- **`operation` sources are not supported.** Remote plugin hosts and
  `sourceReference.hostId` tracks are rejected.
- **`stream` sources from the main thread are not supported.** Extractor
  Readables work only because the worker resolves them locally.
- **`track.related` is not proxied.** Autoplay and related-track lookups that
  rely on runtime-only providers have no handler on the main Player registry.
- **Worker recovery does not resume playback.** After a worker exit, the active
  generation fails. The host must search/play again.
- **Source state is per worker.** Extractors are activated once per worker, not
  once per process.
- **Track transfer is best-effort.** Non-JSON engine handles are dropped.
- **Position is estimated.** It advances from playback time and one-second
  worker position reports.
- **Buffers are copied** across the worker boundary.
- **Filters and volume are graph-level.** Volume is a `volume=<gain>` libav
  filter, not per-sample inline volume.
- **Native dependencies are required.** The audio path does not run in a plain
  browser or edge runtime.
- **No committed test suite or linter** is currently included.

## Troubleshooting

### No audio, but the bot joins the voice channel

Check that Opus encoding works:

```js
const { OpusEncoder } = require("@discord-player/opus");
const encoder = new OpusEncoder({ channels: 2, rate: 48000, frameSize: 960 });
console.log(OpusEncoder.type); // "mediaplex"
encoder.destroy();
```

`@discord-player/opus` and `mediaplex` are dependencies of `workers.dp`, so a
tarball install should include them. If `mediaplex` failed to install, the
worker logs `GUILD_PLAY failed` while constructing the encoder.

### `extractors.register expects a BaseExtractor subclass constructor`

This usually means two copies of `discord-player` or
`@discord-player/plugin-host` are loaded.

- Install this package from the tarball, not with `yarn add file:...`.
- Import `BaseExtractor` from `"discord-player"`, not from a different copy.
- Deduplicate `discord-player` and `@discord-player/plugin-host` in the host
  application.
- Make sure extractors use the same `discord-player` version as the bot.

### `SourceUnavailableError` or a provider is not found in the worker

- Ensure `registerSources` awaits all registrations.
- Ensure every provider used for search is also registered in the worker.
- Check the worker log for `GUILD_PLAY failed`.

### `Worker playback thread exited with code 1`

On versions before `1.0.3`, this could be an idle-worker reap. Upgrade to the
latest tarball. On current versions, intentional reaps and shutdowns are
suppressed; a real crash also prints `Worker playback thread failed` with a
stack trace.

### `GUILD_DELETE timed out`

Before `1.0.3`, a stalled source resolution or audio probe could hold the guild
lock for more than five seconds. Current versions abort the play and use a
bounded teardown lock.

### `Worker playback cannot accept a Readable from the main thread`

The extractor's `track.stream` ran on the main thread. Register it through
`sources.module`; providers registered directly on the main Player are not
intercepted.

### A new tarball is not picked up

Bump `version` in `package.json`, repack, then remove and re-add the package.
Yarn may cache a tarball by name and version.

## Development

```bash
yarn install
yarn build
```

Build entries:

- `src/index.ts` → `dist/index.mjs` / `dist/index.cjs`
- `src/worker/voice-processor.worker.ts` → `dist/worker.mjs` / `dist/worker.cjs`

`dist/source.mjs` / `dist/source.cjs` are shared runtime chunks.

`yarn typecheck` is available, but the repository includes `lavalink.example.ts`,
a reference example that has pre-existing type errors and is not part of the
build.

## License

This package is licensed under [Apache License 2.0](./LICENSE)