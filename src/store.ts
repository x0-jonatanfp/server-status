/**
 * Persistencia del estado: que mensaje tiene cada canal.
 *
 * Se guarda el id del mensaje para poder **editarlo** en el siguiente ciclo en
 * vez de borrar y reenviar (el bot antiguo creaba un mensaje nuevo cada 5
 * minutos y con el se perdian reacciones e hilos). Guardar el id es tambien lo
 * que hace que un reinicio del servicio no deje un mensaje huerfano.
 *
 * La escritura es atomica (fichero temporal + rename) para que un corte a mitad
 * no deje el JSON a medias: un estado corrupto se descarta y se empieza de cero,
 * nunca impide arrancar.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type winston from "winston";

export const STATE_VERSION = 1;

export interface ChannelState {
  /** Id del mensaje de estado vigente. `null` si aun no se ha publicado. */
  messageId: string | null;
  /** ISO de la ultima actualizacion correcta. */
  updatedAt: string | null;
}

export interface BotState {
  version: number;
  /**
   * Canal elegido con `/set_channel`. Si es `null` se usa el del `.env`.
   * Se persiste para que la eleccion sobreviva a un reinicio (el bot antiguo
   * escribia su configuracion en un fichero que nadie volvia a leer).
   */
  statusChannelId: string | null;
  channels: Record<string, ChannelState>;
}

export interface StateStoreOptions {
  path: string;
  logger?: Pick<winston.Logger, "warn" | "debug">;
}

function emptyState(): BotState {
  return { version: STATE_VERSION, statusChannelId: null, channels: {} };
}

export class StateStore {
  private readonly path: string;
  private readonly logger?: StateStoreOptions["logger"];
  private state: BotState = emptyState();
  private loaded = false;

  constructor(options: StateStoreOptions) {
    this.path = options.path;
    this.logger = options.logger;
  }

  /** Lee el estado del disco. Si falta o esta corrupto, empieza vacio. */
  async load(): Promise<BotState> {
    try {
      const raw = await readFile(this.path, "utf8");
      this.state = parseState(raw);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        this.logger?.debug(`no hay estado previo en ${this.path}: se empieza vacio`);
      } else {
        this.logger?.warn(`estado ilegible en ${this.path}, se empieza vacio: ${String(error)}`);
      }
      this.state = emptyState();
    }
    this.loaded = true;
    return this.state;
  }

  /** Estado en memoria (carga el fichero la primera vez que se pide). */
  async snapshot(): Promise<BotState> {
    if (!this.loaded) await this.load();
    return this.state;
  }

  async getChannelState(channelId: string): Promise<ChannelState | null> {
    const state = await this.snapshot();
    return state.channels[channelId] ?? null;
  }

  async getMessageId(channelId: string): Promise<string | null> {
    return (await this.getChannelState(channelId))?.messageId ?? null;
  }

  /** Canal fijado con `/set_channel`, o `null` si nunca se ha fijado. */
  async getStatusChannelId(): Promise<string | null> {
    return (await this.snapshot()).statusChannelId;
  }

  async setStatusChannelId(channelId: string | null): Promise<void> {
    const state = await this.snapshot();
    state.statusChannelId = channelId;
    await this.save();
  }

  /** Fija el id del mensaje vigente de un canal y lo persiste. */
  async setMessageId(channelId: string, messageId: string | null, updatedAt = new Date()): Promise<void> {
    const state = await this.snapshot();
    state.channels[channelId] = { messageId, updatedAt: updatedAt.toISOString() };
    await this.save();
  }

  /** Escribe el estado en disco de forma atomica. */
  async save(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.tmp`;
    await writeFile(temporary, `${JSON.stringify(this.state, null, 2)}\n`, "utf8");
    await rename(temporary, this.path);
  }
}

/** Valida el JSON guardado; cualquier cosa rara se trata como estado vacio. */
export function parseState(raw: string): BotState {
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null) throw new Error("el estado no es un objeto");

  const { version, channels, statusChannelId } = parsed as {
    version?: unknown;
    channels?: unknown;
    statusChannelId?: unknown;
  };
  if (version !== STATE_VERSION) throw new Error(`version de estado desconocida: ${String(version)}`);
  if (typeof channels !== "object" || channels === null) throw new Error("el estado no tiene canales");

  const state = emptyState();
  // Campo anadido despues: un estado antiguo sin el sigue siendo valido.
  state.statusChannelId = typeof statusChannelId === "string" ? statusChannelId : null;
  for (const [channelId, value] of Object.entries(channels as Record<string, unknown>)) {
    if (typeof value !== "object" || value === null) continue;
    const { messageId, updatedAt } = value as { messageId?: unknown; updatedAt?: unknown };
    state.channels[channelId] = {
      messageId: typeof messageId === "string" ? messageId : null,
      updatedAt: typeof updatedAt === "string" ? updatedAt : null,
    };
  }
  return state;
}
