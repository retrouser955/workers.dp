import { clearTimeout, setTimeout } from "node:timers";
import { parentPort, workerData } from "node:worker_threads";
import { VoiceProcessingGuild } from "../guild";
import {
    loadSourceRuntime,
    readWorkerSourceOptions,
    resolveWorkerSource,
    type SourceRuntime
} from "../source";
import type { GuildPayload, Payload, WorkerOperationReply } from "./worker.type";
import { AsyncQueue } from "discord-player/dist/utils/async-queue";

if (!parentPort) throw new Error("Must be inside a worker");

const guildMap = new Map<string, VoiceProcessingGuild>();
const taskQueue = new AsyncQueue();
const sourceOptions = readWorkerSourceOptions(workerData);
const sourceResolveTimeoutMs = sourceOptions?.resolveTimeoutMs ?? 30_000;

let sourceRuntimePromise: Promise<SourceRuntime> | null = null;

function withDeadline<T>(
    promise: Promise<T>,
    timeoutMs: number,
    label: string,
    signal?: AbortSignal
): Promise<T> {
    if (signal?.aborted) return Promise.reject(signal.reason);

    return new Promise<T>((resolve, reject) => {
        let settled = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        let onAbort: (() => void) | undefined;

        const cleanup = () => {
            if (timer !== undefined) clearTimeout(timer);
            if (onAbort) signal?.removeEventListener("abort", onAbort);
        };

        const finish = (callback: () => void) => {
            if (settled) return;
            settled = true;
            cleanup();
            callback();
        };

        onAbort = () => finish(() => reject(signal?.reason));
        signal?.addEventListener("abort", onAbort, { once: true });

        timer = setTimeout(
            () => finish(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`))),
            timeoutMs
        );

        promise.then(
            (value) => finish(() => resolve(value)),
            (error) => finish(() => reject(error))
        );
    });
}

/**
 * Each worker owns one source host. It is created on the first play and shared
 * by every guild in this worker, so extractor sessions are not duplicated per
 * guild.
 */
function getSourceRuntime(timeoutMs: number, signal?: AbortSignal): Promise<SourceRuntime | null> {
    if (!sourceOptions) return Promise.resolve(null);

    sourceRuntimePromise ??= loadSourceRuntime(sourceOptions);
    return withDeadline(sourceRuntimePromise, timeoutMs, "Source runtime startup", signal);
}

function describeError(error: unknown) {
    return error instanceof Error ? error.message : String(error);
}

function postMessage(op: GuildPayload["op"], guildId: string, data: Record<string, unknown>, requestId?: string) {
    const message: WorkerOperationReply = {
        op,
        d: {
            ...data,
            guildId
        } as WorkerOperationReply["d"]
    };

    if (requestId !== undefined) message.requestId = requestId;

    parentPort?.postMessage(message);
}

function reply(payload: GuildPayload, data: Record<string, unknown>) {
    postMessage(payload.op, payload.d.guildId, data, payload.requestId);
}

function isGuildPayload(payload: Payload): payload is GuildPayload {
    return payload.op !== "VOICE_SERVER_UPDATE" && payload.op !== "VOICE_STATE_UPDATE";
}

function guardGuild(payload: GuildPayload) {
    const guild = guildMap.get(payload.d.guildId);
    if (!guild) {
        reply(payload, {
            exists: false,
            success: false
        });
        return;
    }
    return guild;
}

async function handlePayload(payload: Payload) {
    switch (payload.op) {
        case "VOICE_SERVER_UPDATE":
        case "VOICE_STATE_UPDATE": {
            if (!payload.d.guild_id) return;
            guildMap.get(payload.d.guild_id)?.recieve(payload);
            return;
        }
        case "GUILD_CREATE": {
            using _lock = await taskQueue.acquire(payload.d.guildId);
            if (guildMap.has(payload.d.guildId)) {
                reply(payload, {
                    exists: true,
                    success: false
                });
                return;
            }
            guildMap.set(payload.d.guildId, new VoiceProcessingGuild(payload.d.guildId));
            reply(payload, {
                exists: false,
                success: true
            });
            return;
        }
        case "GUILD_CONNECT": {
            const guild = guardGuild(payload);
            if (!guild) return;

            await guild.connect(payload.d.channelId, payload.d.selfDeaf, payload.d.selfMute, payload.d.timeoutMs);
            reply(payload, {
                exists: true,
                success: true
            });
            return;
        }
        case "GUILD_PLAY": {
            const guild = guardGuild(payload);
            if (!guild) return;

            const { info, token } = await guild.play(async (signal) => {
                // One deadline covers runtime startup, extractor resolution,
                // and stream transforms for this play.
                const resolutionSignal = AbortSignal.any([
                    signal,
                    AbortSignal.timeout(sourceResolveTimeoutMs)
                ]);

                const runtime = await getSourceRuntime(sourceResolveTimeoutMs, resolutionSignal);

                return resolveWorkerSource(runtime, payload.d.resource, payload.d.guildId, {
                    signal: resolutionSignal
                });
            }, payload.d.skipTo);
            reply(payload, {
                success: true,
                info,
                token
            });
            return;
        }
        case "GUILD_DISCONNECT": {
            const guild = guardGuild(payload);
            if (!guild) return;

            const disconnected = await guild.disconnect();
            reply(payload, {
                success: true,
                disconnected
            });
            return;
        }
        case "GUILD_CHANGE_FILTER": {
            const guild = guardGuild(payload);
            if (!guild) return;

            await guild.setAudioFilter(payload.d.filter);
            reply(payload, { success: true });
            return;
        }
        case "GUILD_STOP": {
            const guild = guardGuild(payload);
            if (!guild) return;

            await guild.stop();
            reply(payload, { success: true });
            return;
        }
        case "GUILD_SET_VOLUME": {
            const guild = guardGuild(payload);
            if (!guild) return;

            await guild.setVolume(payload.d.volume);
            reply(payload, { success: true });
            return;
        }
        case "GUILD_DELETE": {
            const guild = guardGuild(payload);
            if (!guild) return;

            try {
                await guild.destroy();
                reply(payload, { success: true });
            } catch (error) {
                reply(payload, {
                    success: false,
                    error: describeError(error)
                });
            } finally {
                // The manager already dropped the assignment, so an orphaned guild
                // could never be addressed again.
                guildMap.delete(payload.d.guildId);
            }
            return;
        }
        case "GUILD_PAUSE":
        case "GUILD_RESUME": {
            const guild = guardGuild(payload);
            if (!guild) return;

            const changed = payload.op === "GUILD_PAUSE"
                ? await guild.pause()
                : await guild.resume();

            reply(payload, {
                success: true,
                changed
            });
            return;
        }
        case "GUILD_GET_PAUSED": {
            const guild = guardGuild(payload);
            if (!guild) return;

            reply(payload, {
                paused: guild.paused
            });
            return;
        }
    }
}

parentPort.on("message", (payload: Payload) => {
    void handlePayload(payload).catch((error: unknown) => {
        if (!isGuildPayload(payload)) return;

        console.error(
            `[workers.dp] ${payload.op} failed for guild ${payload.d.guildId}: ${describeError(error)}`
        );

        try {
            reply(payload, {
                success: false,
                error: describeError(error)
            });
        } catch {
            // The parent port may already be gone; nothing else can be reported.
        }
    });
});
