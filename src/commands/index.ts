/**
 * Registro de comandos.
 *
 * Seis comandos y ninguno duplicado: el bot antiguo tenia 13 con parejas que
 * hacian lo mismo (`/status` y `/status_info`, `/set_channel` y
 * `/configure_channel`, `/update_now` y `/force_update`).
 */
import type { CommandDefinition } from "./types.ts";
import { botStatusCommand } from "./botStatus.ts";
import { helpUnbanCommand } from "./helpUnban.ts";
import { setChannelCommand } from "./setChannel.ts";
import { statusCommand } from "./status.ts";
import { unbanCommand } from "./unban.ts";
import { updateCommand } from "./update.ts";

export const commands: readonly CommandDefinition[] = [
  statusCommand,
  setChannelCommand,
  updateCommand,
  botStatusCommand,
  unbanCommand,
  helpUnbanCommand,
];

export const commandNames: readonly string[] = commands.map((command) => command.data.name);

export function findCommand(name: string): CommandDefinition | undefined {
  return commands.find((command) => command.data.name === name);
}

/** Definiciones en JSON, listas para registrarlas por guild. */
export function commandPayloads(): ReturnType<CommandDefinition["data"]["toJSON"]>[] {
  return commands.map((command) => command.data.toJSON());
}

export type { CommandContext, CommandDefinition, CommandInteraction, CommandReply } from "./types.ts";
