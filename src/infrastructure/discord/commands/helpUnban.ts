/**
 * `/help-unban` — ayuda del desbaneo.
 */
import { SlashCommandBuilder } from "discord.js";

import { ensureRole } from "./access.ts";
import type { CommandDefinition } from "./types.ts";

export const helpUnbanCommand: CommandDefinition = {
  data: new SlashCommandBuilder()
    .setName("help-unban")
    .setDescription("Ayuda del sistema de autodesbaneo de fail2ban"),

  async execute(interaction, context) {
    if (!(await ensureRole(interaction, context))) return;

    const roles =
      context.config.requiredRoles.length > 0
        ? context.config.requiredRoles.join(", ")
        : "cualquiera";

    const content = [
      "🔓 **Autodesbaneo de fail2ban**",
      "",
      "Si te has quedado fuera por un baneo automático, alguien con permiso puede levantarlo:",
      "`/unban <ip>` desbanea esa IP **en todas las cárceles** (sshd, nginx, postfix, dovecot, postgresql, recidive...).",
      "",
      "• La lista de cárceles se pregunta a fail2ban en el momento, no está fijada en el código.",
      "• La IP se valida antes de tocar nada: si no es una IP, no se ejecuta ningún comando.",
      "• Se informa del resultado cárcel por cárcel, y si alguna falla se dice cuál.",
      "",
      `Roles con permiso: ${roles}.`,
      "El estado del sistema, con el total de IPs baneadas por cárcel, está en el mensaje de estado.",
    ].join("\n");

    await interaction.reply({ content, ephemeral: true });
  },
};
