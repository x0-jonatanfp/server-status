/**
 * `/status` — estado completo del sistema.
 *
 * Responde solo a quien lo invoca (salvo que se pida `publico`), para no llenar
 * el canal de mensajes de estado duplicados.
 */
import { SlashCommandBuilder } from "discord.js";

import { ensureRole } from "./access.ts";
import type { CommandDefinition } from "./types.ts";

export const statusCommand: CommandDefinition = {
  data: new SlashCommandBuilder()
    .setName("status")
    .setDescription("Muestra el estado completo del sistema (solo para ti por defecto)")
    .addBooleanOption((option) =>
      option
        .setName("publico")
        .setDescription("Publicar la respuesta en el canal en vez de solo para ti"),
    ),

  async execute(interaction, context) {
    if (!(await ensureRole(interaction, context))) return;

    const snapshot = await context.collect();
    await interaction.reply({
      view: context.render(snapshot),
      ephemeral: !interaction.getBoolean("publico"),
    });
  },
};
