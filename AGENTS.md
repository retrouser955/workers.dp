# AGENTS.md

Guidance for agents working in this repository.

## Project status

**This project is a buildable Discord Player v8 playback backend, not a finished
library.** It implements a `PlaybackBackend` that runs per-guild Discord voice
connections and native audio processing in Node.js worker threads, and it
registers itself as Discord Player's `playback.backend` provider through
`workerPlugin(...)`.

The repository is usable as a plugin package, but it is not polished or fully
covered:

- There is no test runner, test suite, linter, or formatter.
- `README.md` contains only the project title.
- No example bot or controller is committed. `lavalink.example.ts` is an
  untracked reference example; it is not a build entry and does not typecheck
  because `shoukaku` is not installed.
- Verification probes used during development live outside the repository and
  are not part of the project.
- `src/worker/index.ts` is an empty file and is not a build entry. The worker
  entry is `src/worker/voice-processor.worker.ts`, built as
  `workers.dp/worker`.
- Native dependencies (`node-av`, `@mediabunny/server`) require their platform
  binaries. The audio path cannot run in a plain browser or edge runtime.

Do not assume that a named module or API is implemented because a related type,
file, or import exists. Verify against the source. Some capabilities are
intentionally absent and declared as unsupported rather than silently failing:
session-level `stream` and all `operation` sources, remote source hosts, and
crossfade/staging. Extractor `Readable`s are supported only because they are
resolved and consumed inside a playback worker.

## What the code currently does

The repository combines:

- **Discord Player v8** (`discord-player`) plugin and `PlaybackBackend` types.
- **`@discordjs/voice`** for Discord voice connections and audio playback.
- **`node-av`** (native FFmpeg/libav bindings) for audio filter graphs.
- **`mediabunny`** / **`@mediabunny/server`** for demuxing/decoding media into
  `node-av` frames.
- **Node.js worker threads** as the unit of guild voice processing.

One worker thread owns a set of guilds and performs voice connection, playback,
filtering, and transport control inside the worker. The manager process
distributes guilds across workers, relays Discord gateway voice events, and
forwards the worker's outbound gateway payloads to the application's `send`
function. A main-thread `WorkerPlaybackSession` exposes each guild as a Discord
Player session by sending requests over the worker protocol.

## Public API

`src/index.ts` exports:

- `workerPlugin` and `WORKER_PLUGIN_ID`
- `WorkerBackend`
- `WorkerPlaybackSession`
- `WorkerManager`
- `SourceRuntime` and `loadSourceRuntime`
- `WorkerBackendOptions`, `WorkerManagerOptions`, `WorkerMode`,
  `WorkerModeFixed`, `WorkerModeGrow`, `WorkerPluginOptions`,
  `WorkerPlaybackSessionTimeouts`, `WorkerSourceOptions`,
  `SourceRuntimeOptions`, and `SourceRegistrar`

The backend is registered with Discord Player's plugin host:

```ts
import { Player } from "discord-player";
import { workerPlugin } from "workers.dp";

const player = new Player({
    send: (guildId, payload) => {
        // Forward the payload through your gateway connection.
        return true;
    },
    plugins: [
        workerPlugin({
            mode: { type: "grow", guildPerWorker: 8 },
            // Must point at a built worker entry Node can execute.
            workerScript: import.meta.resolve("workers.dp/worker"),
            // Optional: register extractors in the main-thread query host and
            // in every worker's streaming host.
            sources: {
                module: new URL("./sources.mjs", import.meta.url).href,
                options: { /* structured-cloneable */ }
            }
        })
    ]
});

await player.initialize(clientId);
```

`workerScript` is passed directly to `new Worker(...)`. Use the built
`workers.dp/worker` export (`dist/worker.mjs` or `dist/worker.cjs`), not the
TypeScript source.

## Source resolution

Discord Player resolves sources on the main thread before calling
`session.play()`. A Node `Readable` cannot cross a `postMessage` boundary, so the
backend splits the source host in two:

1. **Main-thread source host** (`workerPlugin` setup) registers
   `search.query.match` and `search.query.resolve`. It only queries metadata.
2. **Worker source hosts** each load the same module and register a
   provider-scoped `track.stream` proxy on the main Player. The proxy replaces
   the usual stream resolution with an internal URL token
   (`workers.dp:source:<base64url>`). The worker decodes the token, restores the
   `Track`, and calls its own `PluginRegistry.resolveStream()` under the guild
   operation lock.

The `sources.module` module must export:

```ts
import type { SourceRuntime } from "workers.dp";

export async function registerSources(
    runtime: SourceRuntime,
    options: unknown
): Promise<void> {
    // Legacy extractors:
    await runtime.extractors.register(MyExtractor, options);

    // Modern source plugins (definePlugin returns a factory):
    await runtime.plugins.register(myPlugin(options));
}
```

`registerSources` must await every registration; providers discovered after
setup have no `track.stream` proxy. The module runs in the main thread and in
every worker, so credentials must come from environment variables or the
module's own configuration, not from cloned objects. Relative and absolute
module paths resolve from `process.cwd()`; package specifiers and `file:` URLs
pass through. The module must be executable by Node (JavaScript or ESM), not
TypeScript source.

Each worker owns one `SourceRuntime`, created lazily on the first play and
shared by all guilds in that worker. Extractor instances, cookies, and rate
limits are therefore duplicated per worker. Tracks carry their serialized
`Track` data and, when JSON-safe and under 256 KiB, `track.raw`. Non-JSON engine
handles and `sourceState` are best-effort and may not survive.

Providers registered directly on the main Player (rather than through
`sources.module`) are not intercepted. Their `track.stream` runs on the main
thread and a `Readable` is rejected by the session. Remote `hostId` tracks
require `operation` support, which this backend does not declare.

## Repository layout

| Path | State | Role |
| --- | --- | --- |
| `src/index.ts` | Implemented | Package entry. Exports the plugin, backend, session, manager, source runtime, and option types. |
| `src/worker/index.ts` | Empty (0 bytes) | Unused barrel. Not a build entry. |
| `src/worker/voice-processor.worker.ts` | Implemented | Worker-thread entry. Owns `guildMap`, lazily creates one `SourceRuntime` per worker, receives messages, constructs `VoiceProcessingGuild`, replies to the parent. |
| `src/worker/worker.type.ts` | Implemented | Parent/worker payloads (`Payload`), operation replies, `WorkerMessage`, `GUILD_PLAYBACK_ENDED`, `GUILD_POSITION`, and gateway-payload shape. |
| `src/guild/index.ts` | Implemented | `VoiceProcessingGuild`: per-guild voice connection, playback, filters, pause/resume/stop, position reporting, and gateway voice event forwarding. |
| `src/audio/index.ts` | Implemented | Re-exports `./audio-filter-stream`. |
| `src/audio/audio-filter-stream.ts` | Implemented | Media loading/decoding, libav filter graph processing, filter validation, live filter changes, and a finite PCM `PassThrough`. |
| `src/playback/index.ts` | Implemented | `WorkerPlaybackSession`: Discord Player `PlaybackSession` over the worker protocol, with request timeouts, state, events, filters, volume, pause/resume/seek, and disposal. |
| `src/manager/worker-manager.ts` | Implemented | `WorkerManager` pool with `grow`/`fixed` modes, guild assignment, payload routing, gateway relay, worker recovery, reaping, and shutdown. |
| `src/backend/index.ts` | Implemented | `WorkerBackend`: Discord Player `PlaybackBackend`, gateway forwarding, session lifecycle, and shutdown. |
| `src/source/index.ts` | Implemented | Standalone `SourceRuntime` (`PluginRegistry` + `ExtractorExecutionContext`), source-module loading, Track source tokens, and worker-side stream resolution. |
| `tsdown.config.ts` | Present | Dual ESM/CJS build for `src/index.ts` and `src/worker/voice-processor.worker.ts`. |
| `tsconfig.json` | Present | Strict TypeScript config; see [Toolchain](#toolchain). |
| `package.json` | Configured | Dependencies, entries, exports, `files`, and build/typecheck scripts. |
| `README.md` | Placeholder | Only `# workers.dp`. |
| `lavalink.example.ts` | Reference only | Untracked architecture example. Not built; has pre-existing type errors. |
| `.gitignore` | Present | Standard Yarn/node ignores plus `dist/*`. |

Directories under `node_modules/` are dependencies and must not be edited.
`dist/` is generated and gitignored.

## Message protocol

Defined in `src/worker/worker.type.ts`; handled in
`src/worker/voice-processor.worker.ts`.

Inbound messages are plain objects `{ op, requestId?, d }`. The worker replies
with the same `op` and echoes `requestId` when one was supplied. Every reply
includes `guildId` in `d`. A session always supplies a `requestId` and ignores
replies that do not carry one. Manager-originated messages do not supply one;
their replies are still emitted by the manager as `message` events.

`guardGuild` sends `{ exists: false, success: false }` when the guild is not
present in `guildMap`. Unexpected handler errors are caught and replied to as
`{ success: false, error: <message> }` when the payload is a guild operation.

| `op` | Inbound `d` | Worker behavior | Reply fields |
| --- | --- | --- | --- |
| `GUILD_CREATE` | `guildId` | Creates a `VoiceProcessingGuild` under a per-guild `AsyncQueue` lock. | `exists` (`false` on creation, `true` if it already existed), `success` (`true` on creation) |
| `GUILD_DELETE` | `guildId` | Calls `guild.destroy()`, then removes it from `guildMap` even if teardown failed. | `success`, optionally `error` |
| `GUILD_CONNECT` | `guildId`, `channelId`, optional `selfDeaf`, `selfMute`, `timeoutMs` | Joins or rejoins the voice channel via `guild.connect()`. | `exists`, `success`, optionally `error` |
| `GUILD_DISCONNECT` | `guildId` | Calls `guild.disconnect()`. | `success`, `disconnected` (whether a live connection existed), optionally `error` |
| `GUILD_PLAY` | `guildId`, `resource` (source descriptor), optional `skipTo` (ms) | If `resource` is a `workers.dp:source:` URL, loads the worker source runtime, restores the Track, and resolves its stream inside the guild operation lock. Then creates a filter stream and plays it. | `success`, `info` (probe metadata), `token`, optionally `error` |
| `GUILD_CHANGE_FILTER` | `guildId`, `filter` | Validates and applies a libav filter string. | `success`, optionally `error` |
| `GUILD_STOP` | `guildId` | Calls `guild.stop()`. | `success`, optionally `error` |
| `GUILD_PAUSE` | `guildId` | Calls `guild.pause()`. | `success`, `changed` |
| `GUILD_RESUME` | `guildId` | Calls `guild.resume()`. | `success`, `changed` |
| `GUILD_GET_PAUSED` | `guildId` | Reads `guild.paused`. | `paused` |
| `GUILD_SET_VOLUME` | `guildId`, `volume` (0–2) | Stores gain and applies it through the active filter graph. | `success`, optionally `error` |
| `VOICE_SERVER_UPDATE` | Discord gateway voice server data | Forwarded to the guild's voice adapter; buffered if no adapter is registered yet. No reply. | — |
| `VOICE_STATE_UPDATE` | Discord gateway voice state data | Forwarded to the guild's voice adapter; buffered if no adapter is registered yet. No reply. | — |

Outbound messages not in the table:

- `GUILD_PLAYBACK_ENDED` `{ guildId, token, positionMs, error? }` — sent by
  `VoiceProcessingGuild` when the player reaches `Idle`, errors, or loses its
  connection. `token` identifies the playback generation; the session ignores
  stale tokens. `error` is a string when playback failed.
- `GUILD_POSITION` `{ guildId, token, positionMs, paused }` — sent once per
  second while the player is `Playing` or `Paused`, and only for the active
  token.
- `{ guild, payload }` — raw Discord gateway payloads produced by the voice
  adapter. `WorkerManager` emits these as `gatewayPayload` rather than as a
  `WorkerMessage`; `WorkerBackend` forwards them through the backend context's
  `send` function.

Notes:

- Replies are correlated by `requestId`. Concurrent same-operation requests for
  one guild are independent.
- `VOICE_SERVER_UPDATE` and `VOICE_STATE_UPDATE` are imported from
  `src/guild/index.ts` and included in the `Payload` union there.
- `GuildPayload` is the guild-operation subset of `Payload`; operation replies
  use `GuildPayload["op"]`, which keeps voice updates out of the reply type.
- The worker has no request retry or acknowledgement for `GUILD_CREATE`; the
  manager sends `GUILD_CREATE` before any operation for a newly assigned guild,
  and relies on worker message ordering.

## Guild layer (`src/guild/index.ts`)

`VoiceProcessingGuild` requires `parentPort` and throws if constructed outside a
worker. It owns one guild's:

- Discord voice connection (`joinVoiceChannel` / `getVoiceConnection`).
- `AudioPlayer`, created lazily by `ensureAudioPlayer()`.
- Audio filter state (`audioFilterString`, `audioFilterCallback`) and volume.
- A per-guild `AsyncQueue` for serializing operations.
- Playback generation (`playbackToken`), the active playback token, skip
  offset, and the position-report interval.

Key behaviors:

- `connect(channelId, selfDeaf = true, selfMute = false, timeoutMs = 10000)`
  serializes on the guild queue and rejects on a destroyed guild or empty
  channel.
  - If an existing live connection already matches the channel and both join
    flags and is `Ready`, it returns immediately.
  - If it matches but is `Disconnected`, it calls `rejoin(...)` and waits for
    `ready`.
  - Any channel or join-flag change destroys the existing connection and
    performs a fresh join. `rejoin()` returns before the new session is usable,
    so it is not used for changes.
  - A fresh join that does not become ready within `timeoutMs` destroys the
    connection and rejects with `"Connection timeout"`.
  - A `reconnecting` flag suppresses the destroyed-connection playback failure
    caused by a deliberate teardown.
- `recieve(...)` (note the spelling) forwards gateway voice events to the
  adapter methods registered by `@discordjs/voice`. Before an adapter exists it
  stores the latest voice state and voice server packet, then flushes them when
  the adapter creator is invoked.
- `ensureAudioPlayer()` requires a live voice connection, creates an
  `AudioPlayer` with `NoSubscriberBehavior.Play`, installs permanent `error` and
  `stateChange` listeners, and subscribes it to the connection. The `error`
  listener is required: an unhandled `error` event would terminate the worker.
- `play(sourceOrResolver, skipTo)` requires a live voice connection. A resolver
  function receives the play `AbortSignal` and is awaited while the guild
  operation lock is held. The controller is aborted by `stop()`,
  `disconnect()`, and `destroy()`, so extractor resolution or a stalled probe
  cannot hold the lock indefinitely. It re-checks the destroyed flag, signal,
  and connection after resolution, destroys a resolved `Readable` on failure,
  then increments the playback token, clears the previous resource and position
  timer, creates a filter stream with the concatenated user filter and
  `volume=<gain>` under a 15-second probe deadline, pipes it through an
  `OpusEncoder` from `@discord-player/opus` (`mediaplex` provider, 48 kHz,
  stereo, 960-sample frames), and plays an `AudioResource` with
  `inputType: StreamType.Opus` and `inlineVolume: false`. It returns the probe
  `info` and the token. Source errors destroy the encoder, encoder `close` or
  `error` destroys the source, and `ensureAudioPlayer`/`createAudioResource`
  failures destroy both, so stop/skip cannot leave the filter loop parked.
- Playback end is reported from:
  - `AudioPlayer` transitioning from a non-`Idle` state to `Idle`, using the
    old state's `playbackDuration` plus the skip offset;
  - `AudioPlayer` `error`;
  - `VoiceConnection` `error` or unexpected `Destroyed` state.
  `endPlayback` checks the token, stops the position timer, destroys the
  producer stream (so the filter loop cannot park on backpressure), and posts
  `GUILD_PLAYBACK_ENDED`.
- `setVolume(volume)` accepts a finite 0–2 value and recompiles the active
  filter graph with `volume=<gain>`. It goes through the same locked path as
  filter changes, so it cannot deadlock against a live filter change.
- `setAudioFilter(filter)` validates `filter` plus `OUTPUT_FORMAT`, then either
  stores it for the next playback or calls the live `changeAudioFilter`. A
  `FilterAPIOutdatedError` is treated as success (the filter is stored for
  later).
- `pause()`, `resume()`, `stop()`, `disconnect()`, and `destroy()` map to the
  `AudioPlayer`/`VoiceConnection`. `stop()` and `disconnect()` abort the active
  play, acquire `QUEUE_OPERATION_LOCK` with a two-second deadline, and fall back
  to best-effort teardown if a play is still unwinding. Both bump
  `playbackToken` and destroy the current resource stream so no stale end event
  is reported. `destroy()` marks the guild destroyed, aborts the play, awaits
  `disconnect()`, and always removes the player's listeners even if teardown
  throws.
- All mutation methods acquire the per-guild `QUEUE_OPERATION_LOCK` via
  `AsyncQueue`, using `using` for automatic release. `stop()` and `disconnect()`
  use an explicit bounded acquire instead so teardown cannot be starved by a
  slow play.

## Audio pipeline (`src/audio/audio-filter-stream.ts`)

`createFilterStream(source, filter?, skipTo?, signal?)`:

1. Loads the source with `mediabunny`:
   - `{ url }` → `UrlSource`
   - `{ file }` → `FilePathSource`
   - `{ buffer }` → `BufferSource`
   - `{ stream }` → `ReadableStreamSource` over `Readable.toWeb`, for
     worker-side extractor output
2. Selects the primary audio track (`AudioSampleSink`) and probes codec, sample
   rate, channel count, and duration with `getCodec`, `getSampleRate`,
   `getNumberOfChannels`, and `computeDurationOrNull`.
3. Concatenates the caller filter with `OUTPUT_FORMAT` (s16, 48 kHz, stereo) and
   validates it with libav via `FilterGraph.parse`.
4. Creates a `FilterAPI` and decodes samples, converting each to a project
   `node-av` `Frame` with `Frame.fromAudioBuffer`.
5. Runs frames through the filter graph, buffers three output buffers, then
   writes a concatenated chunk to a `PassThrough`.
6. Honors backpressure by waiting for `drain`, `close`, `error`, or `finish`.
7. Supports live filter replacement: `changeAudioFilter` validates and parks a
   new `FilterAPI`, which is promoted at a sample boundary by
   `settlePendingFilter()`; promotion closes the previous instance.
8. Ends normally at end of input: flushes the buffered output, calls
   `passThrough.end()`, and closes the filters. On error it destroys the stream
   with the error. `closeResources()` always closes filters and disposes the
   `Input`, which cancels in-flight sink work and closes the decoder.
9. Returns `{ stream, changeAudioFilter, info }`.

The optional `signal` cancels only the probe and filter allocation. An abort
listener disposes the `Input`, and it is removed before the function returns, so
a probe timeout cannot abort the live stream. `VoiceProcessingGuild.play`
combines the play signal with a 15-second probe deadline.

`MediaSourceDescriptor` is the serialisable worker boundary and stays limited to
URL, file, and buffer. `PlayableMediaSource` adds a Node `Readable` for sources
resolved by the worker's own host. A stream is append-only, so seeking decodes
forward rather than performing random access. Plugin `operation` sources are
still rejected: the worker does not implement remote operation transport.

`registerMediabunnyServer()` is called at module scope to register the
libavcodec decoders Mediabunny uses for compressed audio. It is idempotent.

`createAudioFrame` exists because `@mediabunny/server` depends on its own nested
`node-av` v6 while this package uses `node-av` v7. Its `toAvFrame` rejects
frames created by the root `node-av`, so the conversion is done directly:
interleaved `f32` samples are copied with `AudioSample.allocationSize` /
`copyTo` and wrapped with `Frame.fromAudioBuffer`.

Channel layout mapping: 1 → mono, 2 → stereo, 4 → quad, 5 → 5.0, 6 → 5.1,
7 → 6.1, 8 → 7.1. Other channel counts use `AV_CHANNEL_ORDER_UNSPEC` with mask
`0n`.

Exported helpers and constants:

- `OUTPUT_FORMAT` — the required Discord PCM format string.
- `verifyAudioFilter(filter)` — allocates, parses, and always frees a temporary
  `FilterGraph`; returns a boolean.
- `concatFilterString(...filters)` — trims leading/trailing commas and joins
  with commas.
- `removeTrailingCommas(input)` — removes one leading and one trailing comma.
- `FilterAPIOutdatedError` — signals that a filter instance has been closed.
- `MediaSourceDescriptor`, `PlayableMediaSource`, and `FilterStreamInfo` types.

`PassThrough` is configured with a custom `destroy` that closes the current and
pending `FilterAPI` instances, disposes the input, and destroys an owned Node
`Readable` producer.

## Playback layer (`src/playback/index.ts`)

`WorkerPlaybackSession<Metadata>` implements Discord Player's `PlaybackSession`
as a main-thread proxy over `WorkerManager`. It does not own a voice connection
or audio player itself; every operation is dispatched to the guild's worker.

Construction is
`new WorkerPlaybackSession(options, manager, lifetime?, timeouts?)`:

- `options` is `PlaybackSessionOptions` (`guildId`, `channelId`, optional
  `userId`, `volume`, `selfDeaf`, `selfMute`, `filterGraph`, and other session
  options).
- `manager` is the `WorkerManager` used for dispatch and for `message` and
  `guildReassigned` events.
- `lifetime` is an optional `AbortSignal`; aborting it disposes the session.
- `timeouts` is an optional `WorkerPlaybackSessionTimeouts` with
  `requestTimeoutMs` (default 30 s) and `connectTimeoutMs` (default 15 s).

Identity and state:

- `sessionId` (`randomUUID()`), `guildId`, `nodeId` (`null` — workers are not
  Discord Player nodes), and mutable `channelId`.
- `connectionState`: `disconnected` → `connecting` → `connected`, or `failed`.
- `state`: Discord Player's playback states (`idle`, `starting`, `playing`,
  `pausing`, `paused`, `resuming`, `stopping`, `stopped`, `completed`,
  `failed`).
- `position` is an estimated clock based on `Date.now()`, the seek/position
  base, and whether the clock is running. `mediaPositionAccuracy` is
  `"estimated"`.
- `durationMs` comes from the worker's source probe and is `null` when unknown.
- `snapshot` reports `generation`, `state`, `source`, `filterGraph`,
  `crossfade: null`, and `staged: null`.
- `volume`, `selfDeaf`, and `selfMute` reflect the last accepted values.

Source support:

- `{ url }`, `{ file }`, and `{ buffer }` are accepted. Buffers are copied
  before transfer so the caller can keep reusing its own buffer.
- `{ url }` values beginning with `workers.dp:source:` are internal Track tokens
  produced by a provider-scoped `track.stream` proxy. Their `metadata.url` is
  reported as `{ source: "worker" }` instead of exposing the token.
- `{ stream }` and `{ operation }` throw explicit unsupported errors. A stream
  produced on the main thread cannot be transferred to a worker.
- `play()` returns a synthetic `AudioStreamInfo` populated from the worker's
  probe (`codec`, `sampleRate`, `channels`, `durationMs`) and source metadata
  (`url`, `file`, or `bufferBytes`). `channelLayout` and `bitRate` are `null`.

Operations:

- `connect(options = {})` sends `GUILD_CONNECT` with the current join flags and
  a timeout, then:
  - queries `GUILD_GET_PAUSED` and resumes a stale paused player from a
    previous session;
  - applies a non-default volume;
  - applies the configured filter without emitting a filter change event.
  Concurrent `connect()` calls share one in-flight promise. Failure sets
  `connectionState` to `failed` and emits `voiceFailed`.
- `move(channelId)` dispatches `GUILD_CONNECT` for the new channel and updates
  `channelId`. It is a no-op when already connected to that channel.
- `play(source, options)` dispatches `GUILD_PLAY` with the source descriptor,
  stores `customMetadata`, sets the state to `starting`, and emits
  `playbackStarted` after a successful reply. If a terminal event arrived while
  the request was in flight, it does not overwrite that state.
- `stop()`, `pause()`, and `resume()` dispatch `GUILD_STOP`, `GUILD_PAUSE`, and
  `GUILD_RESUME`. `pause()` only accepts `starting`/`playing`; `resume()` only
  accepts `paused`.
- `seek(positionMs)` validates a finite nonnegative position, clamps to the
  known duration, re-dispatches `GUILD_PLAY` with `skipTo`, resets the clock,
  re-pauses if the session was paused, and emits `playbackSeeked`.
- `setVolume(gain)` validates 0–2 and dispatches `GUILD_SET_VOLUME`.
- `setSelfDeaf` / `setSelfMute` rejoin through `GUILD_CONNECT` when connected.
- `filters.set(graph)` / `filters.clear()` dispatch `GUILD_CHANGE_FILTER` and
  emit `filterChanged` only when the graph changes.
- `dispose()` is idempotent. It freezes the clock, marks the current generation
  terminal, clears the worker token, sets the connection to `disconnected` and
  the state to `stopped`, rejects pending requests, sends `GUILD_DELETE` with a
  5-second timeout, removes manager listeners, emits `sessionDisposed`, and
  clears local listeners. Awaiting the delete prevents a replacement session
  from racing the guild teardown.
- `getPlaybackTime()` returns the estimated elapsed time.
- `getPlaybackRate()` returns `1`; `getMediaTime()` returns `null` before a
  source is opened, otherwise the same estimate.

Request handling:

- Every request gets a `randomUUID()` request ID. The worker echoes it, and
  replies without an ID are ignored.
- Every request has a timeout. The caller's `AbortSignal` and the timeout are
  combined with `AbortSignal.any`; a timeout rejects the pending request.
- A `GUILD_DELETE` for an unassigned guild resolves synthetically because there
  is nothing left to tear down.
- `replyError` maps `exists: false` to "Guild is not registered with the
  worker", and `success: false` to the worker's `error` string or a generic
  operation failure.

Events are typed through `DiscordSessionEvents<Metadata>` and implemented with a
local listener map (`on`/`off`), not `EventEmitter`. Playback completion comes
from the worker's `GUILD_PLAYBACK_ENDED` message; the session converts it into
`playbackCompleted` or `playbackFailed` for the current generation and ignores
stale tokens. `GUILD_POSITION` updates the estimate only for the active token
while `playing` or `paused`.

If the owning worker exits, `WorkerManager` emits `guildReassigned`. The session
rejects pending requests, freezes the clock, fails the active generation, and
sets the connection state to `failed`. It does not transparently resume the
generation on the replacement worker.

## Manager layer (`src/manager/worker-manager.ts`)

`WorkerManager` extends `EventEmitter` and owns a `worker_threads` pool.

Sizing modes:

```ts
interface WorkerModeGrow { type: "grow"; guildPerWorker: number }
interface WorkerModeFixed { type: "fixed"; workers: number }
```

- `fixed` spawns `workers` workers in the constructor and assigns guilds
  round-robin.
- `grow` starts with no workers, assigns to the least-loaded worker below
  `guildPerWorker`, and spawns another worker when all are full. It does not
  shrink on demand, but idle workers with no guilds are reaped after 30 seconds.

Construction requires
`{ mode, workerScript, workerData?, sources?, maxRespawns? }`.
`workerScript` is passed directly to `new Worker(...)` and must be executable by
Node (a built worker entry, not the `.ts` source). `maxRespawns` defaults to 10.

When `sources` is set, `workerData` is wrapped as
`{ __workersDpSources: { sources, userData } }`; otherwise it is passed through
unchanged. `userData` is not consumed by the built worker and is reserved for
custom worker entries. `WorkerBackendOptions` inherits `sources` and forwards it
to the manager.

Runtime behavior:

- `addGuild(guildId)` assigns a guild and posts `GUILD_CREATE` once. Returns the
  owning worker.
- `removeGuild(guildId)` unassigns and posts `GUILD_DELETE`. Returns `false`
  when the guild was not assigned. Scheduling reaping is grow-mode only.
- `dispatch(payload)` routes a payload by guild. Guild operations auto-assign
  unknown guilds; `GUILD_DELETE` is routed only if the guild is assigned; the
  two `VOICE_*` events are forwarded only when the guild is already assigned.
- `getWorker(guildId)`, `getGuilds(worker)`, `workerCount`, and `guildCount`
  expose pool state.
- `terminate()` clears assignments, posts `GUILD_DELETE` for every assignment,
  waits 150 ms so workers can send the OP 4 leave packet, then terminates every
  worker. It is idempotent.
- `isTerminatingWorker(worker)` reports whether the manager intentionally
  stopped a worker. `terminate()` and idle reaping register workers before
  calling `Worker.terminate()`, which exits with code 1. The backend uses this
  to avoid logging intentional shutdowns as worker crashes.
- When a worker exits, its assignments are removed and `workerExit` is emitted.
  If it had guilds and the respawn limit has not been reached:
  - a fixed pool spawns a replacement worker;
  - every former guild is assigned to a worker via `pickWorker()`;
  - `GUILD_CREATE` is posted to the replacement;
  - `guildReassigned(guildId, worker, previousWorker)` is emitted per guild.
- If the respawn limit is reached, a `workerError` is emitted and the guilds are
  left unassigned; no `guildReassigned` event is emitted.
- Events: `message` (payload, worker), `gatewayPayload` (payload, guildId,
  worker), `workerCreated` (worker), `workerError` (error, worker), `workerExit`
  (code, worker), `guildReassigned` (guildId, worker, previousWorker). Raw
  `{ guild, payload }` messages from the voice adapter are emitted as
  `gatewayPayload` rather than as `message`.

## Backend and plugin (`src/backend/index.ts`, `src/index.ts`)

`WorkerBackend` implements `PlaybackBackend`:

- `id` is `tech.1980s.discord-player-worker.backend`.
- `capabilities` declares `sources: ["url", "file", "buffer"]`,
  `crossfade: false`, and `filters: true`.
- `initialize(context)` creates the `WorkerManager`, stores the context, raises
  the manager's listener limit to unlimited (sessions and the backend share one
  emitter), subscribes to `gatewayPayload`, `workerError`, and `workerExit`, and
  registers an abort handler on `context.signal`. If the signal is already
  aborted, it destroys the backend and throws.
- `receive(packet)` consumes raw gateway dispatches:
  - `GUILD_DELETE` disposes every session for that guild.
  - `VOICE_STATE_UPDATE` is forwarded only when `d.user_id` matches
    `context.clientId`; forwarding another member's update would overwrite
    `@discordjs/voice`'s stored session and user IDs.
  - `VOICE_SERVER_UPDATE` is forwarded as-is.
- `createSession(options, signal)` constructs a `WorkerPlaybackSession` with the
  configured timeouts, tracks it, and removes it on `sessionDisposed`.
- `destroy()` is idempotent. It clears context, removes listeners, disposes all
  tracked sessions with `Promise.allSettled`, then terminates the manager.
- Worker errors and unexpected nonzero exits are logged to the console.
  Nonzero exits caused by `WorkerManager.terminate()` or idle reaping are
  skipped because `Node` reports `Worker.terminate()` as exit code 1.
- Gateway payloads are sent through `context.send(guildId, payload)`; send
  failures are logged. Only OP 4 packets whose `d.guild_id` matches the worker's
  guild are forwarded.

`workerPlugin` is created with `definePlugin`, has ID
`tech.1980s.discord-player-worker`, and its `setup`:

1. calls `ctx.provide("playback.backend", new WorkerBackend(ctx.options))`;
2. when `sources` is configured, loads a main-thread `SourceRuntime` and
   registers `search.query.match` / `search.query.resolve` handlers that delegate
   to it;
3. enumerates `runtime.plugins.describe()` and registers one thin proxy plugin
   per provider ID on the main Player registry.

The proxy step exists because `track.stream` dispatch is scoped to
`track.sourceReference.pluginId`; a handler registered under the backend plugin
ID is never selected for an extractor track. Each proxy returns
`{ url: encodeSourceToken(track) }`. If the provider is already registered
directly on the main Player, the proxy is skipped and worker interception cannot
override it. Proxy registration happens during `setup`, so `sources.module` must
await all provider registrations.

## Toolchain

- **Package manager:** Yarn 1.x (`packageManager: yarn@1.22.1`). `yarn.lock` is
  present.
- **Runtime used locally:** Node.js 24.20.0.
- **TypeScript:** 7.0.2 (`module: nodenext`, `target: esnext`, `strict: true`,
  `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
  `isolatedModules`, `moduleDetection: force`, `skipLibCheck`).
- **Build tool:** `tsdown` 0.23.7 (`tsdown.config.ts`).
- **Tests:** none. No test runner is installed or configured.
- **Lint/format:** none.

Build configuration:

- Entries are `src/index.ts` (`index`) and
  `src/worker/voice-processor.worker.ts` (`worker`).
- Output is `dist/index.mjs` / `dist/index.cjs` and `dist/worker.mjs` /
  `dist/worker.cjs`, plus a shared `dist/source.mjs` / `dist/source.cjs`
  chunk, with `.d.mts` / `.d.cts` declarations and source maps.
- All dependencies are externalized (`deps.neverBundle: true`,
  `deps.resolveDepSubpath: true`). This is required for
  `discord-player/dist/utils/async-queue` and native packages to resolve at
  runtime.
- `hash: false`, `clean: true`, `sourcemap: true`, `platform: "node"`.

`package.json` declares `main`, `module`, `types`, `exports` (`"."`,
`"./worker"`, and `"./package.json"`), `files: ["dist"]`, and the `build` and
`typecheck` scripts. It has no `"type": "module"` field; the dual-format exports
select ESM or CJS explicitly.

The root `node-av` is 7.1.0. `@mediabunny/server` nests `node-av` 6.2.0. This
version split is why `createAudioFrame` performs its own conversion instead of
calling `@mediabunny/server`'s `toAvFrame`.

Opus encoding is provided by `@discord-player/opus` 7.2.0, which loads
`mediaplex` 1.0.0 and its platform binary (`mediaplex-win32-x64-msvc` on this
machine). The worker creates the encoder with 48 kHz, stereo, 960-sample frames
and passes it to `createAudioResource` as `StreamType.Opus`.

## Commands

```bash
yarn install
yarn build
yarn typecheck
```

`yarn build` writes the dual-format bundles to `dist/`.

`yarn typecheck` (or `npx tsc --noEmit`) currently reports the five pre-existing
errors in `lavalink.example.ts` and exits nonzero:

- `TS2307` for the missing `shoukaku` module.
- `TS2339` for `ready` on `PlayerGatewayConnector`.
- `TS2339` for `raw` on `PlayerGatewayConnector`.
- `TS7006` for implicit `any` on `node` and on `error`.

`lavalink.example.ts` is a reference example, not part of the build. Any error
outside that file indicates a regression. A clean typecheck would require
excluding the example or installing its missing dependency; do not do that as
an incidental change.

## Known limitations and residual defects

These are observed in the current code. They are not a roadmap.

1. **No committed tests or linting.** Verification currently relies on external
   probes and manual runs.
2. **No consumer application.** The package exposes the plugin, but no bot,
   controller, or gateway wiring is included. A host must provide `send` and
   feed gateway dispatches to the backend.
3. **`src/worker/index.ts` is unused.** The built worker is produced from
   `voice-processor.worker.ts`; the empty barrel is misleading.
4. **`lavalink.example.ts` does not typecheck.** It is retained as an
   architecture reference and is excluded from the build entries.
5. **Position is estimated.** `WorkerPlaybackSession.position` advances from
   `Date.now()` at 1x and resyncs from one-second `GUILD_POSITION` reports. The
   worker's `positionMs` is based on `AudioPlayer.playbackDuration` plus the
   skip offset, so decode stalls and rate changes can drift.
6. **Source metadata is probe-only.** `durationMs` is `null` when the container
   cannot report it, and `channelLayout` / `bitRate` are always `null`.
7. **Unsupported source variants.** Session-level `stream` and all `operation`
   sources are rejected, and `crossfade`/staging are not implemented
   (`crossfade: false`, no staging methods). Extractor `Readable`s work only
   because a worker resolves and consumes them locally.
8. **Worker recovery does not resume playback.** After `guildReassigned`, the
   active generation fails and pending requests reject. The host must call
   `connect()` and `play()` again to recover. The `maxRespawns` budget is global
   and never replenished; once exhausted, later worker exits leave guilds
   unassigned.
9. **Respawn-limit exits do not notify sessions.** When `maxRespawns` is
   reached, the manager emits `workerError` but not `guildReassigned`, so a
   session's in-flight requests rely on their timeouts to fail.
10. **A timed-out rejoin can leave a connection in place.** A fresh join that
    times out is destroyed, but a `rejoin()` on a matching `Disconnected`
    connection that never becomes ready rejects without destroying it.
11. **`play()` requires an existing connection.** `WorkerPlaybackSession.play()`
    does not call `connect()`; callers must connect first.
12. **Disposal tears down the guild connection.** `dispose()` sends
    `GUILD_DELETE`, which stops playback and disconnects the guild. A
    replacement session must reconnect. This is intentional but expensive.
13. **Filter/volume changes are graph-level.** `volume` is implemented as a
    `volume=<gain>` libav filter after the caller's graph, not as per-sample
    inline volume. Changes apply at filter-graph boundaries, not instantly.
14. **Native/platform dependency.** Audio filtering and frame conversion depend
    on native `node-av` and `@mediabunny/server` binaries. The audio path is not
    usable in a plain, unbuilt JS environment. Opus encoding uses
    `@discord-player/opus` with the native `mediaplex` provider, so `mediaplex`
    and its platform binary must install successfully. `@discordjs/voice` does
    not need its own Opus encoder on this path because the resource is created
    with `StreamType.Opus`; a missing `mediaplex` binary makes `GUILD_PLAY` fail
    while constructing the encoder.
15. **Buffers are copied across the worker boundary.** Large buffer sources
    cost memory and a structured-clone copy; use URLs or files for large media.
16. **No request replay.** A worker request that receives no reply fails by
    timeout; there is no retry or idempotency key beyond `requestId`.
17. **Source state is duplicated per worker.** Each worker loads
    `sources.module` independently. Cookies, tokens, caches, and rate limits are
    not shared with the main query host or with other workers.
18. **Track transfer is best-effort.** A worker receives the serialised `Track`
    plus JSON-safe `raw` under 256 KiB. Non-JSON engine handles are dropped, and
    a token larger than 512 KiB is rejected. `sourceState` is forwarded but only
    the originating host could interpret it.
19. **Direct main-thread providers are not intercepted.** Providers registered
    on the Player rather than through `sources.module` keep their own
    `track.stream` handler. A `Readable` from one of those providers fails at
    `session.play()`.
20. **Remote source hosts are unsupported.** Tracks whose `sourceReference` has
    a `hostId` require `capabilities.sources` to include `operation` and a
    matching `pluginHosts` entry; the backend declares neither.
21. **`track.related` is not proxied.** Autoplay and related-track lookups that
    use the main Player registry have no handler for providers that live in the
    source runtime. `track.stream`, `search.query.match`, and
    `search.query.resolve` are the proxied operations.
22. **Source resolution has a fixed deadline.** A worker gives source-runtime
    startup, `track.stream`, and stream transforms one shared 30-second deadline
    by default (`sources.resolveTimeoutMs`). Audio probing has a separate
    15-second deadline. `stop()`, `disconnect()`, and `destroy()` abort the
    active play and acquire the guild lock with a two-second teardown deadline.
    If the lock still cannot be acquired, teardown proceeds best-effort and the
    aborted play unwinds later.
23. **A timed-out runtime startup can continue in the background.** The worker
    stops waiting at the deadline, but a native extractor `activate()` call that
    ignores cancellation may still be running. The worker is reaped after its
    last guild is removed, which terminates that work.
24. **Idle worker reaping uses exit code 1.** `Worker.terminate()` is reported by
    Node as exit code 1. `WorkerManager.isTerminatingWorker()` distinguishes
    intentional termination from a crash; only unexpected exits are logged.

## Conventions present in the code

- 4-space indentation.
- Double quotes for strings; semicolons are usually present but not consistently.
- Relative imports omit `.js` extensions (e.g. `../guild`, `./worker.type`).
- Interfaces are exported directly; types are grouped by domain folder with
  `index.ts` entry points (`audio`, `guild`, `playback`, `source`, `worker`).
- Async mutual exclusion uses `AsyncQueue` plus `using` / `Symbol.dispose`.
- Deep imports into `discord-player/dist/...` are currently used for
  `AsyncQueue`; this is a private path, not a documented package export.
- Most files have no comments; `audio-filter-stream.ts` has JSDoc on the filter
  helpers and on the cross-version frame conversion.
- `VoiceProcessingGuild.recieve` is intentionally spelled that way; do not
  "fix" it without updating callers and the public gateway types.

## Working guidelines

- Read the relevant source before relying on a module; several files are small
  and the protocol is defined by the union types, not by documentation alone.
- Keep changes scoped to the task. Do not add unrelated features, scripts, or
  tooling.
- Do not edit anything under `node_modules/`.
- Preserve the `OUTPUT_FORMAT` contract unless the audio path is the task; it is
  what makes the PCM stream consumable by `@discordjs/voice`.
- Treat the worker as a worker-only module. `voice-processor.worker.ts` and
  `VoiceProcessingGuild` throw when `parentPort` is unavailable, so importing
  them on the main thread is not valid.
- Keep main-thread code free of native audio imports where possible; the main
  bundle must not eagerly load `node-av` or `@mediabunny/server`.
- Run `yarn build` after TypeScript changes and confirm it succeeds. Run
  `yarn typecheck` and compare against the five-error `lavalink.example.ts`
  baseline above.
- Do not describe currently absent functionality as if it works.
