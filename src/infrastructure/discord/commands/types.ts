/**
 * Tipos de los comandos.
 *
 * Los manejadores no hablan con discord.js: reciben una `CommandInteraction`
 * minima y devuelven una respuesta con `content` o con la vista ya renderizada.
 * El adaptador de discord.js (en `../client.ts`) es quien convierte eso en una
 * respuesta real de Discord. Asi los seis comandos se pueden probar de verdad
 * sin conexion de gateway.
 */
import type { SharedSlashCommand } from "discord.js";

import type { StatusSnapshot } from "../../../domain/entities/status-snapshot.ts";
import type { StatusView } from "../../../domain/entities/status-view.ts";
import type { Fail2banUnbanResult } from "../../../domain/entities/fail2ban-status.ts";
import type { Inventory } from "../../../domain/entities/inventory.ts";
import type { LoggerPort } from "../../../domain/ports/logger.ts";
import type { StateStorePort } from "../../../domain/ports/state-store.ts";
import type { StatusLoop } from "../../../application/publish-status.ts";
import type { AppConfig } from "../../config/env.ts";

export interface CommandReply {
  /** Texto plano, para mensajes de error o de confirmacion. */
  content?: string;
  /** Mensaje de estado ya renderizado (Components V2). */
  view?: StatusView;
  /** Por defecto los comandos responden solo a quien los invoca. */
  ephemeral?: boolean;
}

export interface CommandInteraction {
  /** Canal donde se ha invocado el comando. */
  channelId: string;
  /** Valor de una opcion de texto o de canal. `null` si no se ha dado. */
  getString(name: string): string | null;
  getBoolean(name: string): boolean;
  /** Nombres de los roles de quien invoca. */
  roleNames(): string[];
  reply(reply: CommandReply): Promise<void>;
}

export interface CommandContext {
  config: AppConfig;
  inventory: Inventory;
  /** Bucle de publicacion (el "scheduler"). */
  scheduler: StatusLoop;
  store: StateStorePort;
  /** Recolecta un snapshot completo para `/status`. */
  collect: () => Promise<StatusSnapshot>;
  render: (snapshot: StatusSnapshot) => StatusView;
  /** Desbaneo en todas las carceles (inyectable en los tests). */
  unban: (ip: string) => Promise<Fail2banUnbanResult>;
  /** Latencia del gateway en milisegundos, o `null` si no se puede medir. */
  gatewayPingMs: () => number | null;
  version: string;
  startedAt: Date;
  logger: LoggerPort;
}

export interface CommandDefinition {
  /**
   * Builder del comando. Es `SharedSlashCommand` (la base de discord.js) y no
   * `SlashCommandBuilder` porque en cuanto se anade una opcion el builder pasa
   * a ser `SlashCommandOptionsOnlyBuilder`.
   */
  data: SharedSlashCommand;
  execute(interaction: CommandInteraction, context: CommandContext): Promise<void>;
}
