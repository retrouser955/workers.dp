import { definePlugin, type PluginContext } from "discord-player";
import { WorkerBackend, type WorkerBackendOptions } from "./backend";
import {
    encodeSourceToken,
    loadSourceRuntime,
    type SourceRuntime
} from "./source";

export { WorkerBackend };
export type { WorkerBackendOptions };
export { WorkerPlaybackSession } from "./playback";
export type { WorkerPlaybackSessionTimeouts } from "./playback";
export { WorkerManager } from "./manager/worker-manager";
export type {
    WorkerManagerOptions,
    WorkerMode,
    WorkerModeFixed,
    WorkerModeGrow
} from "./manager/worker-manager";
export { SourceRuntime, loadSourceRuntime } from "./source";
export type {
    SourceRegistrar,
    SourceRuntimeOptions,
    WorkerSourceOptions
} from "./source";

export const WORKER_PLUGIN_ID = "tech.1980s.discord-player-worker";

// High priority so worker-bound streams win over providers registered directly
// on the main Player registry. Providers that are not registered in the source
// runtime still fall through to their own handlers.
const TRACK_STREAM_PRIORITY = 1_000_000;

export type WorkerPluginOptions = WorkerBackendOptions;

export const workerPlugin = definePlugin<WorkerPluginOptions>({
    id: WORKER_PLUGIN_ID,
    async setup(ctx) {
        ctx.provide("playback.backend", new WorkerBackend(ctx.options));

        const sourceOptions = ctx.options.sources;
        if (!sourceOptions) return;

        // The main-thread host only answers queries. Streams are resolved by
        // the worker host, which owns the extractor instances that produce them.
        const runtime = await loadSourceRuntime(sourceOptions);
        ctx.onCleanup(() => runtime.destroy());

        ctx.on(
            "search.query.match",
            () => (runtime.plugins.describe().length > 0 ? { score: 100 } : null),
            { priority: 100 }
        );

        ctx.on(
            "search.query.resolve",
            (input, { signal }) => runtime.search(input, { signal }),
            { priority: 100 }
        );

        // `track.stream` dispatch is scoped to the Track's provider ID. Register
        // one thin proxy per provider so the actual resolution happens in a
        // worker that owns that provider's extractor instances.
        for (const provider of runtime.plugins.describe()) {
            await registerStreamProxy(ctx, provider.id, runtime);
        }
    }
});

async function registerStreamProxy(
    ctx: PluginContext<WorkerPluginOptions>,
    providerId: string,
    runtime: SourceRuntime
): Promise<void> {
    if (ctx.player.plugins.has(providerId)) {
        // A provider registered directly on the main Player owns its own
        // track.stream handler. Worker interception cannot override it.
        return;
    }

    await ctx.player.plugins.register(
        definePlugin({
            id: providerId,
            setup(pluginCtx) {
                pluginCtx.on(
                    "track.stream",
                    ({ track }) => {
                        if (track.sourceReference?.pluginId !== providerId) return undefined;
                        if (!runtime.plugins.has(providerId) && !runtime.extractors.isRegistered(providerId)) {
                            return undefined;
                        }

                        return { url: encodeSourceToken(track) };
                    },
                    { priority: TRACK_STREAM_PRIORITY }
                );
            }
        })()
    );
}
