import type { DiscordSessionEvents, PlaybackSession, PlaybackSessionOptions } from "discord-player";
import { randomUUID } from "node:crypto";
import type { FilterStreamInfo, MediaSourceDescriptor } from "../audio";
import type { WorkerManager } from "../manager/worker-manager";
import { isSourceToken } from "../source";
import type {
    GuildPlaybackEnded,
    GuildPosition,
    Payload,
    WorkerMessage,
    WorkerOperationReply
} from "../worker/worker.type";

type SessionEventMap<Metadata> = DiscordSessionEvents<Metadata>;
type SessionEventName<Metadata> = keyof SessionEventMap<Metadata>;
type SessionListener = (...args: any[]) => void;
type SessionSource = Parameters<PlaybackSession["play"]>[0];
type SessionPlayOptions<Metadata> = NonNullable<Parameters<PlaybackSession<Metadata>["play"]>[1]>;
type SessionConnectOptions = NonNullable<Parameters<PlaybackSession["connect"]>[0]>;
type SessionSourceInfo = NonNullable<PlaybackSession["snapshot"]["source"]>;
type SessionPosition = PlaybackSession["position"];
type SessionPlaybackState = PlaybackSession["state"];
type SessionConnectionState = PlaybackSession["connectionState"];
type SessionSnapshot = PlaybackSession["snapshot"];
type SessionFilters = NonNullable<PlaybackSession["filters"]>;

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;
const DISPOSE_TIMEOUT_MS = 5_000;
const ACTIVE_STATES: readonly SessionPlaybackState[] = [
    "starting",
    "playing",
    "pausing",
    "resuming",
    "paused"
];

export interface WorkerPlaybackSessionTimeouts {
    /** Default deadline for worker requests. Defaults to 30 seconds. */
    requestTimeoutMs?: number;
    /** Default deadline for voice connections. Defaults to 15 seconds. */
    connectTimeoutMs?: number;
}

interface PendingRequest {
    resolve: (reply: WorkerOperationReply) => void;
    reject: (error: unknown) => void;
    cleanup?: () => void;
}

function toError(value: unknown, fallback: string): Error {
    if (value instanceof Error) return value;
    if (typeof value === "string") return new Error(value);
    if (value !== undefined) return new Error(fallback, { cause: value });
    return new Error(fallback);
}

function sourceDescriptor(source: SessionSource): MediaSourceDescriptor {
    if ("url" in source && typeof source.url === "string") return { url: source.url };
    if ("file" in source && typeof source.file === "string") return { file: source.file };
    if ("buffer" in source && source.buffer instanceof Uint8Array) {
        // Copy so the caller can keep mutating or reusing its buffer.
        return { buffer: new Uint8Array(source.buffer) };
    }
    if ("stream" in source) {
        throw new Error(
            "Worker playback cannot accept a Readable from the main thread; register the provider " +
                "through workerPlugin({ sources }) so its track.stream runs inside the worker"
        );
    }
    if ("operation" in source) {
        throw new Error("Worker playback does not support plugin operation sources");
    }
    throw new Error("Unsupported playback source");
}

function sourceMetadata(source: MediaSourceDescriptor): Readonly<Record<string, string>> {
    if ("url" in source) {
        // A source token is an internal envelope, not a user-facing media URL.
        return isSourceToken(source.url) ? { source: "worker" } : { url: source.url };
    }
    if ("file" in source) return { file: source.file };
    return { bufferBytes: String(source.buffer.byteLength) };
}

function createSourceInfo(
    source: MediaSourceDescriptor,
    info: FilterStreamInfo | undefined
): SessionSourceInfo {
    return {
        streamIndex: 0,
        codec: info?.codec ?? "unknown",
        sampleRate: info?.sampleRate ?? null,
        channels: info?.channels ?? null,
        channelLayout: null,
        durationMs: info?.durationMs ?? null,
        bitRate: null,
        metadata: sourceMetadata(source)
    };
}

export class WorkerPlaybackSession<Metadata = unknown> implements PlaybackSession<Metadata> {
    readonly sessionId: string = randomUUID();
    readonly guildId: string;
    readonly nodeId: string | null = null;
    readonly filters: SessionFilters;

    private readonly manager: WorkerManager;
    private readonly lifetime: AbortSignal | undefined;
    private readonly requestTimeoutMs: number;
    private readonly connectTimeoutMs: number;
    private readonly listeners = new Map<string, Set<SessionListener>>();
    private readonly pending = new Map<string, PendingRequest>();
    private readonly onLifetimeAbort = () => {
        void this.dispose().catch(() => {});
    };

    private _channelId: string;
    private _connectionState: SessionConnectionState = "disconnected";
    private _state: SessionPlaybackState = "idle";
    private _volume: number;
    private _selfDeaf: boolean;
    private _selfMute: boolean;
    private _filterGraph: string | null;
    private _generation = 0;
    private _source: MediaSourceDescriptor | null = null;
    private _sourceInfo: SessionSourceInfo | null = null;
    private _customMetadata: Metadata | undefined;
    private _positionBaseMs = 0;
    private _positionStartedAt: number | null = null;
    private _terminalGeneration = -1;
    private _workerToken: number | null = null;
    private _connectPromise: Promise<void> | null = null;
    private disposed = false;

    constructor(
        options: PlaybackSessionOptions,
        manager: WorkerManager,
        lifetime?: AbortSignal,
        timeouts?: WorkerPlaybackSessionTimeouts
    ) {
        this.guildId = options.guildId;
        this._channelId = options.channelId;
        this._volume = options.volume ?? 1;
        this._selfDeaf = options.selfDeaf ?? true;
        this._selfMute = options.selfMute ?? false;
        this._filterGraph = options.filterGraph ?? null;
        this.requestTimeoutMs = timeouts?.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
        this.connectTimeoutMs = timeouts?.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
        this.manager = manager;
        this.lifetime = lifetime;

        const session = this;
        this.filters = {
            get graph() {
                return session._filterGraph;
            },
            set: (graph) => session.applyFilter(graph),
            clear: () => session.applyFilter(null)
        };

        this.manager.on("message", this.handleMessage);
        this.manager.on("guildReassigned", this.handleGuildReassigned);
        this.lifetime?.addEventListener("abort", this.onLifetimeAbort, { once: true });
    }

    get channelId() {
        return this._channelId;
    }

    get connectionState() {
        return this._connectionState;
    }

    get state() {
        return this._state;
    }

    get position(): SessionPosition {
        const elapsed = this.currentTimeMs();
        return {
            mediaMs: this._source === null ? null : elapsed,
            mediaPositionAccuracy: this._source === null ? null : "estimated",
            submittedMs: elapsed,
            playedMs: elapsed
        };
    }

    get durationMs() {
        return this._sourceInfo?.durationMs ?? null;
    }

    get volume() {
        return this._volume;
    }

    get selfDeaf() {
        return this._selfDeaf;
    }

    get selfMute() {
        return this._selfMute;
    }

    get snapshot(): SessionSnapshot {
        return {
            generation: this._generation,
            state: this._state,
            source: this._sourceInfo,
            filterGraph: this._filterGraph,
            crossfade: null,
            staged: null
        };
    }

    on<K extends SessionEventName<Metadata>>(
        event: K,
        listener: (...args: SessionEventMap<Metadata>[K]) => void
    ): this {
        const key = String(event);
        let listeners = this.listeners.get(key);

        if (!listeners) {
            listeners = new Set();
            this.listeners.set(key, listeners);
        }

        listeners.add(listener as SessionListener);
        return this;
    }

    off<K extends SessionEventName<Metadata>>(
        event: K,
        listener: (...args: SessionEventMap<Metadata>[K]) => void
    ): this {
        this.listeners.get(String(event))?.delete(listener as SessionListener);
        return this;
    }

    async connect(options: SessionConnectOptions = {}): Promise<void> {
        this.assertNotDisposed();
        options.signal?.throwIfAborted();

        if (this._connectionState === "connected") return;
        if (this._connectPromise) return this._connectPromise;

        this._connectPromise = this.performConnect(options);

        try {
            await this._connectPromise;
        } finally {
            this._connectPromise = null;
        }
    }

    private async performConnect(options: SessionConnectOptions): Promise<void> {
        this.setConnectionState("connecting");

        const connectTimeoutMs = options.timeoutMs ?? this.connectTimeoutMs;

        try {
            await this.run({
                op: "GUILD_CONNECT",
                d: {
                    guildId: this.guildId,
                    channelId: this._channelId,
                    selfDeaf: this._selfDeaf,
                    selfMute: this._selfMute,
                    timeoutMs: connectTimeoutMs
                }
            }, options.signal, connectTimeoutMs + 1_000);

            this.setConnectionState("connected");

            // A worker guild may still hold a paused player if a previous session
            // was replaced; a fresh session must never inherit that state.
            const pausedState = await this.request({
                op: "GUILD_GET_PAUSED",
                d: {
                    guildId: this.guildId
                }
            }, options.signal);

            if (pausedState.d.paused) {
                await this.run({
                    op: "GUILD_RESUME",
                    d: {
                        guildId: this.guildId
                    }
                }, options.signal);
            }

            if (this._volume !== 1) {
                await this.run({
                    op: "GUILD_SET_VOLUME",
                    d: {
                        guildId: this.guildId,
                        volume: this._volume
                    }
                }, options.signal);
            }

            if (this._filterGraph !== null) {
                await this.applyFilter(this._filterGraph, false);
            }
        } catch (error) {
            this.setConnectionState("failed");
            this.emitSession("voiceFailed", {
                ...this.voiceIdentity(),
                state: "failed",
                error: toError(error, "Voice connection failed")
            });
            throw error;
        }
    }

    async move(channelId: string): Promise<void> {
        this.assertNotDisposed();
        if (!channelId) throw new TypeError("Voice channel ID must be nonempty");

        if (channelId === this._channelId && this._connectionState === "connected") return;

        await this.run({
            op: "GUILD_CONNECT",
            d: {
                guildId: this.guildId,
                channelId,
                selfDeaf: this._selfDeaf,
                selfMute: this._selfMute,
                timeoutMs: this.connectTimeoutMs
            }
        }, undefined, this.connectTimeoutMs + 1_000);

        this._channelId = channelId;
        if (this._connectionState !== "connected") this.setConnectionState("connected");
    }

    async dispose(): Promise<void> {
        if (this.disposed) return;
        this.disposed = true;

        this.lifetime?.removeEventListener("abort", this.onLifetimeAbort);

        this.freezeClock();
        this._terminalGeneration = this._generation;
        this._workerToken = null;
        this.setConnectionState("disconnected");
        this._state = "stopped";

        this.rejectPending(new Error("Playback session has been disposed"));

        try {
            // Awaiting the delete keeps a replacement session's GUILD_CREATE/GUILD_CONNECT
            // from racing with this guild's teardown.
            await this.request(
                { op: "GUILD_DELETE", d: { guildId: this.guildId } },
                undefined,
                DISPOSE_TIMEOUT_MS,
                true
            );
        } catch {
            // The worker may already have exited; disposal is still complete.
        }

        this.manager.off("message", this.handleMessage);
        this.manager.off("guildReassigned", this.handleGuildReassigned);

        this.emitSession("sessionDisposed", {
            ...this.voiceIdentity(),
            generation: this._generation
        });
        this.listeners.clear();
    }

    async play(source: SessionSource, options: SessionPlayOptions<Metadata> = {}): Promise<SessionSourceInfo> {
        this.assertNotDisposed();
        options.signal?.throwIfAborted();

        const descriptor = sourceDescriptor(source);
        const generation = ++this._generation;

        this._source = descriptor;
        this._sourceInfo = null;
        this._customMetadata = options.customMetadata;
        this._positionBaseMs = 0;
        this._positionStartedAt = null;
        this._terminalGeneration = -1;
        this._workerToken = null;
        this._state = "starting";

        let reply: WorkerOperationReply;
        try {
            reply = await this.request({
                op: "GUILD_PLAY",
                d: {
                    guildId: this.guildId,
                    resource: descriptor
                }
            }, options.signal);

            const failure = this.replyError(reply);
            if (failure) throw failure;
        } catch (error) {
            this.freezeClock();
            this._state = "failed";
            this.emitSession("playbackFailed", {
                ...this.eventIdentity(),
                state: "failed",
                error: toError(error, "Playback failed")
            });
            throw error;
        }

        this._workerToken = reply.d.token ?? null;
        const info = createSourceInfo(descriptor, reply.d.info);
        this._sourceInfo = info;

        if (this._terminalGeneration !== generation) {
            this._state = "playing";
            this._positionStartedAt = Date.now();
            this.emitSession("playbackStarted", {
                ...this.eventIdentity(),
                state: "playing",
                info
            });
        }

        return info;
    }

    async stop(): Promise<void> {
        this.assertNotDisposed();

        if (!ACTIVE_STATES.includes(this._state) && this._state !== "stopping") return;

        this._state = "stopping";

        try {
            await this.run({
                op: "GUILD_STOP",
                d: {
                    guildId: this.guildId
                }
            });
        } catch (error) {
            this.freezeClock();
            this._workerToken = null;
            this._state = "failed";
            this.emitSession("playbackFailed", {
                ...this.eventIdentity(),
                state: "failed",
                error: toError(error, "Unable to stop playback")
            });
            throw error;
        }

        this.freezeClock();
        this._workerToken = null;
        this._state = "stopped";
        this.emitSession("playbackStopped", {
            ...this.eventIdentity(),
            state: "stopped"
        });
    }

    async pause(): Promise<void> {
        this.assertNotDisposed();

        if (this._state === "paused") return;
        if (this._state !== "playing" && this._state !== "starting") {
            throw new Error(`Cannot pause playback while the session is ${this._state}`);
        }

        const previous = this._state;
        this._state = "pausing";

        try {
            await this.run({
                op: "GUILD_PAUSE",
                d: {
                    guildId: this.guildId
                }
            });
        } catch (error) {
            this._state = previous;
            throw error;
        }

        this.freezeClock();
        this._state = "paused";
        this.emitSession("playbackPaused", {
            ...this.eventIdentity(),
            previousState: previous,
            state: "paused"
        });
    }

    async resume(): Promise<void> {
        this.assertNotDisposed();

        if (this._state !== "paused") {
            throw new Error(`Cannot resume playback while the session is ${this._state}`);
        }

        const previous = this._state;
        this._state = "resuming";

        try {
            await this.run({
                op: "GUILD_RESUME",
                d: {
                    guildId: this.guildId
                }
            });
        } catch (error) {
            this._state = previous;
            throw error;
        }

        this._positionStartedAt = Date.now();
        this._state = "playing";
        this.emitSession("playbackResumed", {
            ...this.eventIdentity(),
            previousState: "paused",
            state: "playing"
        });
    }

    async seek(positionMs: number): Promise<void> {
        this.assertNotDisposed();

        if (!Number.isFinite(positionMs) || positionMs < 0) {
            throw new RangeError("Seek position must be a finite nonnegative number");
        }

        const source = this._source;
        if (source === null) {
            throw new Error("Cannot seek before a source has been opened");
        }

        const target = this.durationMs === null
            ? positionMs
            : Math.min(positionMs, this.durationMs);

        const previousPositionMs = this.currentTimeMs();
        const previousState = this._state;
        const wasPaused = previousState === "paused";

        let reply: WorkerOperationReply;
        try {
            reply = await this.request({
                op: "GUILD_PLAY",
                d: {
                    guildId: this.guildId,
                    resource: source,
                    skipTo: target
                }
            });

            const failure = this.replyError(reply);
            if (failure) throw failure;
        } catch (error) {
            this._state = previousState;
            throw error;
        }

        this._workerToken = reply.d.token ?? null;
        if (reply.d.info) this._sourceInfo = createSourceInfo(source, reply.d.info);
        this._positionBaseMs = target;
        this._positionStartedAt = wasPaused ? null : Date.now();
        this._state = wasPaused ? "paused" : "playing";

        if (wasPaused) {
            try {
                await this.run({
                    op: "GUILD_PAUSE",
                    d: {
                        guildId: this.guildId
                    }
                });
            } catch (error) {
                this._positionStartedAt = Date.now();
                this._state = "playing";
                throw error;
            }
        }

        this.emitSession("playbackSeeked", {
            ...this.eventIdentity(),
            positionMs: target,
            requestedPositionMs: positionMs,
            fallback: false,
            previousPositionMs
        });
    }

    async setVolume(gain: number): Promise<void> {
        this.assertNotDisposed();

        if (!Number.isFinite(gain) || gain < 0 || gain > 2) {
            throw new RangeError("Volume must be a finite number between 0 and 2");
        }

        if (gain === this._volume) return;

        const previousVolume = this._volume;

        await this.run({
            op: "GUILD_SET_VOLUME",
            d: {
                guildId: this.guildId,
                volume: gain
            }
        });

        this._volume = gain;
        this.emitSession("volumeChanged", {
            ...this.eventIdentity(),
            previousVolume,
            volume: gain
        });
    }

    async setSelfDeaf(enabled: boolean): Promise<void> {
        this.assertNotDisposed();
        if (enabled === this._selfDeaf) return;

        if (this._connectionState === "connected") {
            await this.run({
                op: "GUILD_CONNECT",
                d: {
                    guildId: this.guildId,
                    channelId: this._channelId,
                    selfDeaf: enabled,
                    selfMute: this._selfMute,
                    timeoutMs: this.connectTimeoutMs
                }
            }, undefined, this.connectTimeoutMs + 1_000);
        }

        this._selfDeaf = enabled;
    }

    async setSelfMute(enabled: boolean): Promise<void> {
        this.assertNotDisposed();
        if (enabled === this._selfMute) return;

        if (this._connectionState === "connected") {
            await this.run({
                op: "GUILD_CONNECT",
                d: {
                    guildId: this.guildId,
                    channelId: this._channelId,
                    selfDeaf: this._selfDeaf,
                    selfMute: enabled,
                    timeoutMs: this.connectTimeoutMs
                }
            }, undefined, this.connectTimeoutMs + 1_000);
        }

        this._selfMute = enabled;
    }

    getPlaybackTime(): number {
        return this.currentTimeMs();
    }

    getPlaybackRate(): number | null {
        return 1;
    }

    getMediaTime(): number | null {
        return this._source === null ? null : this.currentTimeMs();
    }

    private async applyFilter(graph: string | null, emit = true): Promise<void> {
        this.assertNotDisposed();

        const previousGraph = this._filterGraph;

        await this.run({
            op: "GUILD_CHANGE_FILTER",
            d: {
                guildId: this.guildId,
                filter: graph ?? ""
            }
        });

        this._filterGraph = graph;

        if (emit && previousGraph !== graph) {
            this.emitSession("filterChanged", {
                ...this.eventIdentity(),
                previousGraph,
                graph
            });
        }
    }

    private async run(payload: Payload, signal?: AbortSignal, timeoutMs?: number): Promise<void> {
        const reply = await this.request(payload, signal, timeoutMs);
        const error = this.replyError(reply);
        if (error) throw error;
    }

    private request(
        payload: Payload,
        signal?: AbortSignal,
        timeoutMs?: number,
        allowDisposed = false
    ): Promise<WorkerOperationReply> {
        if (this.disposed && !allowDisposed) {
            return Promise.reject(new Error("Playback session has been disposed"));
        }

        signal?.throwIfAborted();

        const requestId = randomUUID();
        const deadlineMs = timeoutMs ?? this.requestTimeoutMs;
        const timeout = AbortSignal.timeout(deadlineMs);
        const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
        combined.throwIfAborted();

        return new Promise((resolve, reject) => {
            const entry: PendingRequest = { resolve, reject };

            const onAbort = () => {
                if (this.pending.get(requestId) !== entry) return;
                this.pending.delete(requestId);

                if (timeout.aborted && !signal?.aborted) {
                    console.error(
                        `[workers.dp] ${payload.op} timed out after ${deadlineMs}ms for guild ${this.guildId}`
                    );
                }

                reject(combined.reason);
            };

            combined.addEventListener("abort", onAbort, { once: true });
            entry.cleanup = () => combined.removeEventListener("abort", onAbort);

            this.pending.set(requestId, entry);

            try {
                const worker = this.manager.dispatch({ ...payload, requestId } as Payload);

                if (!worker && payload.op === "GUILD_DELETE") {
                    // The guild was already unassigned (for example after a worker
                    // exit); there is nothing left to tear down.
                    this.pending.delete(requestId);
                    entry.cleanup();
                    entry.resolve({
                        op: "GUILD_DELETE",
                        d: { guildId: this.guildId, success: true }
                    });
                }
            } catch (error) {
                this.pending.delete(requestId);
                entry.cleanup();
                reject(error);
            }
        });
    }

    private replyError(reply: WorkerOperationReply): Error | null {
        if (reply.d.exists === false) {
            return new Error("Guild is not registered with the worker");
        }

        if (reply.d.success === false) {
            return toError(reply.d.error, "Worker operation failed");
        }

        return null;
    }

    private readonly handleMessage = (payload: WorkerMessage) => {
        if (this.getMessageGuildId(payload) !== this.guildId) return;

        if (payload.op === "GUILD_PLAYBACK_ENDED") {
            this.handlePlaybackEnded(payload);
            return;
        }

        if (payload.op === "GUILD_POSITION") {
            this.handlePosition(payload);
            return;
        }

        if (payload.op === "VOICE_SERVER_UPDATE" || payload.op === "VOICE_STATE_UPDATE") return;

        const requestId = payload.requestId;
        if (requestId === undefined) return;

        const entry = this.pending.get(requestId);
        if (!entry) return;

        this.pending.delete(requestId);
        entry.cleanup?.();
        entry.resolve(payload);
    };

    private readonly handleGuildReassigned = (guildId: string) => {
        if (guildId !== this.guildId) return;

        const error = new Error("The worker owning this guild exited");
        this.rejectPending(error);

        this.freezeClock();
        this._workerToken = null;

        if (ACTIVE_STATES.includes(this._state)) {
            this._terminalGeneration = this._generation;
            this._state = "failed";
            this.emitSession("playbackFailed", {
                ...this.eventIdentity(),
                state: "failed",
                error
            });
        }

        this.setConnectionState("failed");
    };

    private handlePosition(message: GuildPosition) {
        if (message.d.token !== this._workerToken) return;
        if (this._state !== "playing" && this._state !== "paused") return;

        this._positionBaseMs = Math.max(0, message.d.positionMs);
        this._positionStartedAt = message.d.paused ? null : Date.now();
    }

    private handlePlaybackEnded(message: GuildPlaybackEnded): void {
        if (message.d.token !== undefined && message.d.token !== this._workerToken) return;
        if (this._terminalGeneration === this._generation) return;
        if (!ACTIVE_STATES.includes(this._state)) return;

        this._terminalGeneration = this._generation;

        if (message.d.positionMs !== undefined) {
            this._positionBaseMs = Math.max(0, message.d.positionMs);
            this._positionStartedAt = null;
        } else {
            this.freezeClock();
        }

        const position = this.position;

        if (message.d.error !== undefined) {
            this._state = "failed";
            this._workerToken = null;
            this.emitSession("playbackFailed", {
                ...this.eventIdentity(),
                state: "failed",
                error: new Error(message.d.error)
            });
            return;
        }

        this._state = "completed";
        this._workerToken = null;
        this.emitSession("playbackCompleted", {
            ...this.eventIdentity(),
            state: "completed",
            position
        });
    }

    private getMessageGuildId(payload: WorkerMessage): string | undefined {
        if (payload.op === "VOICE_SERVER_UPDATE" || payload.op === "VOICE_STATE_UPDATE") {
            return payload.d.guild_id;
        }

        return payload.d.guildId;
    }

    private setConnectionState(state: SessionConnectionState) {
        if (this._connectionState === state) return;

        const previousState = this._connectionState;
        this._connectionState = state;
        this.emitSession("voiceStateChanged", {
            ...this.voiceIdentity(),
            previousState,
            state
        });
    }

    private currentTimeMs() {
        const elapsed = this._positionStartedAt === null ? 0 : Date.now() - this._positionStartedAt;
        return this._positionBaseMs + elapsed;
    }

    private freezeClock() {
        this._positionBaseMs = this.currentTimeMs();
        this._positionStartedAt = null;
    }

    private rejectPending(error: Error) {
        for (const entry of this.pending.values()) {
            entry.cleanup?.();
            entry.reject(error);
        }
        this.pending.clear();
    }

    private eventIdentity() {
        return {
            sessionId: this.sessionId,
            guildId: this.guildId,
            nodeId: this.nodeId,
            generation: this._generation,
            ...(this._customMetadata === undefined
                ? {}
                : { customMetadata: this._customMetadata })
        };
    }

    private voiceIdentity() {
        return {
            sessionId: this.sessionId,
            guildId: this.guildId,
            nodeId: this.nodeId
        };
    }

    private emitSession<K extends SessionEventName<Metadata>>(
        event: K,
        ...args: SessionEventMap<Metadata>[K]
    ) {
        const listeners = this.listeners.get(String(event));
        if (!listeners) return;

        for (const listener of [...listeners]) {
            listener(...args);
        }
    }

    private assertNotDisposed() {
        if (this.disposed) throw new Error("Playback session has been disposed");
    }
}
