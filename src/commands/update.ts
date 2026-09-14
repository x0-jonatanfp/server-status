/**
 * `/update` — fuerza un ciclo inmediato sin esperar al intervalo.
 */
import { PermissionFlagsBits, SlashCommandBuilder } from "discord.js";

import { formatClock, formatMilliseconds } from "../render/format.ts";
import type { CommandDefinition } from "./types.ts";

export const updateCommand: CommandDefinition = {
  data: new SlashCommandBuilder()
    .setName("update")
    .setDescription("Fuerza una actualizacion inmediata del mensaje de estado")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  async execute(interaction, context) {
    const result = await context.scheduler.runOnce("manual");

    if (result.error !== null) {
      await interaction.reply({
        content: `❌ La actualizacion ha fallado: ${result.error}`,
        ephemeral: true,
      });
      return;
    }

    const action = result.created ? "mensaje creado" : "mensaje editado";
    await interaction.reply({
      content: `✅ ${action} en <#${context.scheduler.channelId}> · ${formatClock(result.at)} · ${formatMilliseconds(result.durationMs)}`,
      ephemeral: true,
    });
  },
};
