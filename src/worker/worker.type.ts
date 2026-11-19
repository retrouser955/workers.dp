import type { FilterStreamInfo, MediaSourceDescriptor } from "../audio";
import type { GuildVoiceParentServerUpdate, GuildVoiceParentStateUpdate } from "../guild";

export interface VoiceGuildCreate {
    op: "GUILD_CREATE";
    requestId?: string;
    d: {
        guildId: string;
    }
}

export interface VoiceGuildDisconnect {
    op: "GUILD_DISCONNECT";
    requestId?: string;
    d: {
        guildId: string;
    }
}

export interface VoiceGuildConnect {
    op: "GUILD_CONNECT";
    requestId?: string;
    d: {
        guildId: string;
        channelId: string;
        selfDeaf?: boolean;
        selfMute?: boolean;
        /** How long the worker may wait for the voice connection to become ready. */
        timeoutMs?: number;
    }
}

export interface VoiceGuildPlay {
    op: "GUILD_PLAY";
    requestId?: string;
    d: {
        guildId: string;
        resource: MediaSourceDescriptor;
        skipTo?: number;
    }
}

export interface VoiceGuildChangeFilter {
    op: "GUILD_CHANGE_FILTER";
    requestId?: string;
    d: {
        guildId: string;
        filter: string;
    }
}

export interface VoiceGuildStop {
    op: "GUILD_STOP";
    requestId?: string;
    d: {
        guildId: string;
    }
}

export interface VoiceGuildDelete {
    op: "GUILD_DELETE";
    requestId?: string;
    d: {
        guildId: string;
    }
}

export interface VoiceGuildPause {
    op: "GUILD_PAUSE";
    requestId?: string;
    d: {
        guildId: string;
    }
}

export interface VoiceGuildResume {
    op: "GUILD_RESUME";
    requestId?: string;
    d: {
        guildId: string;
    }
}

export interface VoiceGuildGetPaused {
    op: "GUILD_GET_PAUSED";
    requestId?: string;
    d: {
        guildId: string;
    }
}

export interface VoiceGuildSetVolume {
    op: "GUILD_SET_VOLUME";
    requestId?: string;
    d: {
        guildId: string;
        volume: number;
    }
}

export type GuildPayload =
    VoiceGuildCreate |
    VoiceGuildDisconnect |
    VoiceGuildConnect |
    VoiceGuildPlay |
    VoiceGuildChangeFilter |
    VoiceGuildStop |
    VoiceGuildDelete |
    VoiceGuildPause |
    VoiceGuildResume |
    VoiceGuildGetPaused |
    VoiceGuildSetVolume;

export type Payload =
    GuildPayload |
    GuildVoiceParentServerUpdate |
    GuildVoiceParentStateUpdate;

export interface WorkerOperationReply {
    op: GuildPayload["op"];
    requestId?: string;
    d: {
        guildId: string;
        success?: boolean;
        exists?: boolean;
        paused?: boolean;
        /** Whether a pause/resume call actually changed the player state. */
        changed?: boolean;
        /** Whether a disconnect call found a live voice connection. */
        disconnected?: boolean;
        /** Worker-side playback token, used to correlate position and end events. */
        token?: number;
        /** Source metadata resolved while opening the stream. */
        info?: FilterStreamInfo;
        error?: unknown;
    }
}

export interface GuildPlaybackEnded {
    op: "GUILD_PLAYBACK_ENDED";
    d: {
        guildId: string;
        token?: number;
        positionMs?: number;
        error?: string;
    }
}

export interface GuildPosition {
    op: "GUILD_POSITION";
    d: {
        guildId: string;
        token: number;
        positionMs: number;
        paused: boolean;
    }
}

export type WorkerMessage = Payload | WorkerOperationReply | GuildPlaybackEnded | GuildPosition;

export interface WorkerGatewayPayload {
    guild: string;
    payload: unknown;
}
