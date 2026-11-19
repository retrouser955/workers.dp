import {
    AudioPlayer,
    AudioPlayerStatus,
    createAudioPlayer,
    createAudioResource,
    getVoiceConnection,
    joinVoiceChannel,
    NoSubscriberBehavior,
    StreamType,
    VoiceConnectionStatus,
    type AudioResource,
    type DiscordGatewayAdapterCreator,
    type DiscordGatewayAdapterLibraryMethods,
    type VoiceConnection,
    type VoiceConnectionState
} from "@discordjs/voice";
import type { APIVoiceState, GatewayVoiceServerUpdateDispatchData } from "discord-api-types/v10";
import { parentPort } from "node:worker_threads";
import { clearInterval, clearTimeout, setInterval, setTimeout } from "node:timers";
import { AsyncQueue } from "discord-player/dist/utils/async-queue";
import {
    concatFilterString,
    createFilterStream,
    FilterAPIOutdatedError,
    OUTPUT_FORMAT,
    verifyAudioFilter,
    type FilterStreamInfo,
    type PlayableMediaSource
} from "../audio";
import { OpusEncoder } from "@discord-player/opus";

export interface GuildVoiceParentServerUpdate {
    op: "VOICE_SERVER_UPDATE";
    d: GatewayVoiceServerUpdateDispatchData;
}

export interface GuildVoiceParentStateUpdate {
    op: "VOICE_STATE_UPDATE",
    d: APIVoiceState;
}

const QUEUE_OPERATION_LOCK = "queue.operation";
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const POSITION_REPORT_INTERVAL_MS = 1_000;
const AUDIO_PROBE_TIMEOUT_MS = 15_000;
const TEARDOWN_LOCK_TIMEOUT_MS = 2_000;

interface ActivePlayback {
    token: number;
}

export interface GuildPlayResult {
    info: FilterStreamInfo;
    token: number;
}

type PlayableSourceInput =
    | PlayableMediaSource
    | ((signal: AbortSignal) => Promise<PlayableMediaSource>);

export class VoiceProcessingGuild {
    private readonly parentPort: MessagePort;
    private voiceAdapter: DiscordGatewayAdapterCreator | undefined;
    private voiceAdapterMethods: DiscordGatewayAdapterLibraryMethods | undefined;
    private observedConnection: VoiceConnection | undefined;
    private pendingVoiceServer: GatewayVoiceServerUpdateDispatchData | undefined;
    private pendingVoiceState: APIVoiceState | undefined;
    audioPlayer: AudioPlayer | undefined;
    private taskQueue = new AsyncQueue();
    private audioFilterCallback: Awaited<ReturnType<typeof createFilterStream>>['changeAudioFilter'] | undefined;
    private audioFilterString?: string;
    private currentResource: AudioResource | undefined;
    private volume = 1;
    private playbackToken = 0;
    private activePlayback: ActivePlayback | undefined;
    private activeSkipToMs = 0;
    private positionTimer: ReturnType<typeof setInterval> | undefined;
    private playController: AbortController | undefined;
    private reconnecting = false;
    private destroyed = false;

    constructor(public guildId: string) {
        if (!parentPort) throw new Error("Must be created in a worker");
        this.parentPort = parentPort;
    };

    recieve(payload: GuildVoiceParentStateUpdate | GuildVoiceParentServerUpdate) {
        if (payload.d.guild_id !== this.guildId) return;

        const methods = this.voiceAdapterMethods;

        if (payload.op === "VOICE_SERVER_UPDATE") {
            if (!methods) {
                this.pendingVoiceServer = payload.d;
                return;
            }
            methods.onVoiceServerUpdate(payload.d);
            return;
        }

        if (!methods) {
            this.pendingVoiceState = payload.d;
            return;
        }
        methods.onVoiceStateUpdate(payload.d);
    }

    private flushPendingVoicePackets() {
        const methods = this.voiceAdapterMethods;
        if (!methods) return;

        const state = this.pendingVoiceState;
        const server = this.pendingVoiceServer;
        this.pendingVoiceState = undefined;
        this.pendingVoiceServer = undefined;

        if (state) methods.onVoiceStateUpdate(state);
        if (server) methods.onVoiceServerUpdate(server);
    }

    async connect(channelId: string, selfDeaf = true, selfMute = false, timeoutMs = DEFAULT_CONNECT_TIMEOUT_MS) {
        using _lock = await this.taskQueue.acquire(QUEUE_OPERATION_LOCK);

        if (this.destroyed) throw new Error("This guild has been destroyed");
        if (!channelId) throw new Error("A voice channel ID is required");

        const existing = getVoiceConnection(this.guildId);
        if (existing && existing.state.status !== VoiceConnectionStatus.Destroyed) {
            const matches =
                existing.joinConfig.channelId === channelId &&
                existing.joinConfig.selfDeaf === selfDeaf &&
                existing.joinConfig.selfMute === selfMute;

            if (matches && existing.state.status === VoiceConnectionStatus.Ready) return existing;

            if (matches && existing.state.status === VoiceConnectionStatus.Disconnected) {
                if (!existing.rejoin({ channelId, selfDeaf, selfMute })) {
                    throw new Error("Failed to update the voice connection");
                }
                await this.waitForReady(existing, timeoutMs);
                return existing;
            }

            // A channel or join-flag change needs a complete gateway handshake.
            // `rejoin()` returns immediately on a ready connection, before the
            // new session is usable, so start from a fresh connection instead.
            this.reconnecting = true;
            try {
                existing.destroy();
            } finally {
                this.reconnecting = false;
            }
        }

        return this.join(channelId, selfDeaf, selfMute, timeoutMs);
    }

    private async join(channelId: string, selfDeaf: boolean, selfMute: boolean, timeoutMs: number) {
        this.voiceAdapter = methods => {
            this.voiceAdapterMethods = methods;
            this.flushPendingVoicePackets();

            return {
                destroy: () => {
                    if (this.voiceAdapterMethods === methods) this.voiceAdapterMethods = undefined;
                },
                sendPayload: (payload) => {
                    this.parentPort.postMessage({
                        guild: this.guildId,
                        payload: payload
                    })
                    return true;
                }
            }
        }

        const connection = joinVoiceChannel({
            channelId,
            guildId: this.guildId,
            selfDeaf,
            selfMute,
            adapterCreator: this.voiceAdapter
        });

        this.observeConnection(connection);

        try {
            await this.waitForReady(connection, timeoutMs);
        } catch (error) {
            connection.destroy();
            throw error;
        }

        this.voiceAdapter = undefined;

        if (this.audioPlayer) connection.subscribe(this.audioPlayer);

        return connection;
    }

    private waitForReady(connection: VoiceConnection, timeoutMs: number): Promise<void> {
        if (connection.state.status === VoiceConnectionStatus.Ready) return Promise.resolve();

        return new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => {
                cleanup();
                reject(new Error("Connection timeout"));
            }, timeoutMs);

            const cleanup = () => {
                clearTimeout(timer);
                connection.off("ready", onReady);
                connection.off("stateChange", onStateChange);
            };

            const onReady = () => {
                cleanup();
                resolve();
            };

            const onStateChange = (_oldState: VoiceConnectionState, newState: VoiceConnectionState) => {
                if (newState.status !== VoiceConnectionStatus.Destroyed) return;
                cleanup();
                reject(new Error("The voice connection was destroyed before becoming ready"));
            };

            connection.once("ready", onReady);
            connection.on("stateChange", onStateChange);
        });
    }

    private observeConnection(connection: VoiceConnection) {
        if (this.observedConnection === connection) return;
        this.observedConnection = connection;

        connection.on("error", (error) => {
            this.endPlayback(error);
        });

        connection.on("stateChange", (_oldState, newState) => {
            if (newState.status !== VoiceConnectionStatus.Destroyed) return;

            if (this.observedConnection === connection) this.observedConnection = undefined;
            this.voiceAdapterMethods = undefined;

            if (this.reconnecting) return;
            this.endPlayback(new Error("The voice connection was destroyed"));
        });
    }

    ensureAudioPlayer(): asserts this is { audioPlayer: AudioPlayer } {
        if (this.audioPlayer) return;

        const connection = getVoiceConnection(this.guildId);
        if (!connection || connection.state.status === VoiceConnectionStatus.Destroyed) {
            throw new Error("Unable to create an audio player without a voice connection.");
        }

        const player = createAudioPlayer({
            behaviors: {
                noSubscriber: NoSubscriberBehavior.Play
            }
        });

        // An unhandled "error" event would terminate the worker thread.
        player.on("error", (error) => {
            this.endPlayback(error);
        });

        player.on("stateChange", (oldState, newState) => {
            if (oldState.status === AudioPlayerStatus.Idle) return;
            if (newState.status !== AudioPlayerStatus.Idle) return;

            const playbackDuration = "playbackDuration" in oldState ? oldState.playbackDuration : 0;
            this.endPlayback(undefined, this.activeSkipToMs + playbackDuration);
        });

        connection.subscribe(player);
        this.audioPlayer = player;
    }

    async disconnect() {
        // Abort source resolution/probing before waiting for the operation lock.
        // A blocked play must not make teardown wait forever.
        this.playController?.abort(new Error("The guild is disconnecting"));

        let lock: { release(): void } | undefined;
        try {
            lock = await this.taskQueue.acquire(QUEUE_OPERATION_LOCK, {
                signal: AbortSignal.timeout(TEARDOWN_LOCK_TIMEOUT_MS)
            });
        } catch {
            // Best-effort teardown. The aborted play checks the signal before
            // installing a resource and will release the lock on unwinding.
        }

        try {
            this.playController = undefined;
            this.teardownPlayback();

            const connection = getVoiceConnection(this.guildId);
            this.voiceAdapter = undefined;
            this.voiceAdapterMethods = undefined;
            this.observedConnection = undefined;
            this.pendingVoiceServer = undefined;
            this.pendingVoiceState = undefined;

            if (!connection) return false;

            connection.destroy();
            return true;
        } finally {
            lock?.release();
        }
    }

    async destroy() {
        this.destroyed = true;
        this.playController?.abort(new Error("The guild has been destroyed"));

        try {
            await this.disconnect();
        } finally {
            this.audioPlayer?.removeAllListeners();
            this.audioPlayer = undefined;
        }
    }

    async play(input: PlayableSourceInput, skipTo?: number): Promise<GuildPlayResult> {
        using _lock = await this.taskQueue.acquire(QUEUE_OPERATION_LOCK);

        if (this.destroyed) throw new Error("This guild has been destroyed");

        const controller = new AbortController();
        this.playController = controller;
        const signal = controller.signal;

        try {
            // Extractor resolution can take seconds. Keep it inside the operation
            // lock so a concurrent stop, disconnect, or destroy cannot be lost.
            const source = typeof input === "function" ? await input(signal) : input;

            if (signal.aborted) {
                if ("stream" in source) source.stream.destroy();
                throw signal.reason ?? new Error("Playback was cancelled");
            }

            if (this.destroyed) {
                if ("stream" in source) source.stream.destroy();
                throw new Error("This guild has been destroyed");
            }

            const connection = getVoiceConnection(this.guildId);
            if (!connection || connection.state.status === VoiceConnectionStatus.Destroyed) {
                if ("stream" in source) source.stream.destroy();
                throw new Error("Unable to play. There are no voice connections for this guild.");
            }

            const token = ++this.playbackToken;
            this.activePlayback = undefined;
            this.stopPositionTimer();
            this.clearCurrentResource();

            // Bound the probe so a stalled source cannot hold the guild lock
            // and delay stop, disconnect, or delete.
            const probeSignal = AbortSignal.any([
                signal,
                AbortSignal.timeout(AUDIO_PROBE_TIMEOUT_MS)
            ]);

            const { stream, changeAudioFilter, info } = await createFilterStream(
                source,
                this.buildAudioFilter(this.audioFilterString),
                skipTo,
                probeSignal
            );

            if (signal.aborted || this.destroyed) {
                stream.destroy();
                throw signal.reason ?? new Error("Playback was cancelled");
            }

            const opusEncoder = new OpusEncoder({
                channels: 2,
                rate: 48000,
                frameSize: 960
            });

            // `pipe` does not forward source errors or destroy the producer when
            // the encoder is stopped. Keep the filter stream and encoder lifetime
            // tied together so stop/skip cannot leave the filter loop parked.
            stream.once("error", (error) => {
                if (!opusEncoder.destroyed) opusEncoder.destroy(error);
            });
            opusEncoder.once("close", () => {
                if (!stream.destroyed) stream.destroy();
            });
            opusEncoder.on("error", () => {
                if (!stream.destroyed) stream.destroy();
            });

            stream.pipe(opusEncoder);

            const clearCallback = () => {
                if (this.audioFilterCallback === changeAudioFilter) {
                    this.audioFilterCallback = undefined;
                }
            };

            stream.once("end", clearCallback);
            stream.once("close", clearCallback);
            stream.once("error", clearCallback);

            this.audioFilterCallback = changeAudioFilter;

            try {
                this.ensureAudioPlayer();
            } catch (error) {
                stream.destroy();
                opusEncoder.destroy();
                throw error;
            }

            let resource: AudioResource;
            try {
                resource = createAudioResource(opusEncoder, {
                    inlineVolume: false,
                    inputType: StreamType.Opus
                });
            } catch (error) {
                stream.destroy();
                opusEncoder.destroy();
                throw error;
            }

            if (signal.aborted || this.destroyed) {
                stream.destroy();
                opusEncoder.destroy();
                throw signal.reason ?? new Error("Playback was cancelled");
            }

            this.currentResource = resource;
            this.activeSkipToMs = skipTo === undefined ? 0 : Math.max(0, skipTo);
            this.activePlayback = { token };

            try {
                this.audioPlayer.play(resource);
            } catch (error) {
                this.currentResource = undefined;
                stream.destroy();
                opusEncoder.destroy();
                throw error;
            }

            this.startPositionTimer(token);

            return { info, token };
        } finally {
            if (this.playController === controller) this.playController = undefined;
        }
    }

    async setVolume(volume: number) {
        if (!Number.isFinite(volume) || volume < 0 || volume > 2) {
            throw new RangeError("Volume must be a finite number between 0 and 2");
        }

        using _lock = await this.taskQueue.acquire(QUEUE_OPERATION_LOCK);
        this.volume = volume;
        await this.applyAudioFilterLocked(this.audioFilterString || "");
    }

    async setAudioFilter(filter: string) {
        using _lock = await this.taskQueue.acquire(QUEUE_OPERATION_LOCK);
        await this.applyAudioFilterLocked(filter);
    }

    private buildAudioFilter(filter?: string) {
        return concatFilterString(filter ?? "", `volume=${this.volume}`);
    }

    private async applyAudioFilterLocked(filter: string) {
        const audioFilter = this.buildAudioFilter(filter);
        if (!verifyAudioFilter(concatFilterString(audioFilter, OUTPUT_FORMAT))) {
            throw new Error("Invalid filter string");
        }

        const changeAudioFilter = this.audioFilterCallback;
        if (!changeAudioFilter) {
            this.audioFilterString = filter;
            return;
        }

        try {
            await changeAudioFilter(audioFilter);
            this.audioFilterString = filter;
        } catch (error) {
            if (error instanceof FilterAPIOutdatedError) {
                // The stream ended between validation and application. The filter
                // is still stored for the next playback.
                if (this.audioFilterCallback === changeAudioFilter) {
                    this.audioFilterCallback = undefined;
                }
                this.audioFilterString = filter;
                return;
            }

            throw new Error("Failed to apply the audio filter", { cause: error });
        }
    }

    async stop() {
        this.playController?.abort(new Error("Playback stopped"));

        let lock: { release(): void } | undefined;
        try {
            lock = await this.taskQueue.acquire(QUEUE_OPERATION_LOCK, {
                signal: AbortSignal.timeout(TEARDOWN_LOCK_TIMEOUT_MS)
            });
        } catch {
            // Best-effort teardown; the aborted play releases the lock on unwind.
        }

        try {
            this.playController = undefined;
            this.teardownPlayback();
        } finally {
            lock?.release();
        }
    }

    async pause() {
        using _lock = await this.taskQueue.acquire(QUEUE_OPERATION_LOCK);
        if (this.paused) return false;
        return this.audioPlayer?.pause() ?? false;
    }

    async resume() {
        using _lock = await this.taskQueue.acquire(QUEUE_OPERATION_LOCK);
        if (!this.audioPlayer || !this.paused) return false;
        return this.audioPlayer.unpause();
    }

    get paused() {
        if (!this.audioPlayer) return false;
        return this.audioPlayer.state.status === AudioPlayerStatus.Paused;
    }

    private teardownPlayback() {
        this.playbackToken++;
        this.activePlayback = undefined;
        this.stopPositionTimer();
        this.clearCurrentResource();
        this.audioPlayer?.stop();
    }

    private clearCurrentResource() {
        this.currentResource?.playStream.destroy();
        this.currentResource = undefined;
    }

    private currentPositionMs() {
        const state = this.audioPlayer?.state;
        const played =
            state &&
                (state.status === AudioPlayerStatus.Playing || state.status === AudioPlayerStatus.Paused)
                ? state.playbackDuration
                : 0;

        return this.activeSkipToMs + played;
    }

    private startPositionTimer(token: number) {
        this.stopPositionTimer();

        this.positionTimer = setInterval(() => {
            if (this.activePlayback?.token !== token) {
                this.stopPositionTimer();
                return;
            }

            const state = this.audioPlayer?.state;
            if (!state) return;
            if (state.status !== AudioPlayerStatus.Playing && state.status !== AudioPlayerStatus.Paused) return;

            this.parentPort.postMessage({
                op: "GUILD_POSITION",
                d: {
                    guildId: this.guildId,
                    token,
                    positionMs: this.activeSkipToMs + state.playbackDuration,
                    paused: state.status === AudioPlayerStatus.Paused
                }
            });
        }, POSITION_REPORT_INTERVAL_MS);
    }

    private stopPositionTimer() {
        if (!this.positionTimer) return;
        clearInterval(this.positionTimer);
        this.positionTimer = undefined;
    }

    private endPlayback(error?: unknown, positionMs?: number) {
        const active = this.activePlayback;
        if (!active) return;

        this.activePlayback = undefined;
        if (active.token !== this.playbackToken) return;

        this.stopPositionTimer();
        // Destroy the producer even when the player stopped reading it, otherwise the
        // filter loop parks forever on backpressure.
        this.clearCurrentResource();

        const message: Record<string, unknown> = {
            guildId: this.guildId,
            token: active.token,
            positionMs: positionMs ?? this.currentPositionMs()
        };

        if (error !== undefined) {
            message.error = error instanceof Error ? error.message : String(error);
        }

        this.parentPort.postMessage({
            op: "GUILD_PLAYBACK_ENDED",
            d: message
        });
    }
}
