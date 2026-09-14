/**
 * `/set_channel [canal]` — canal donde se publica el estado.
 *
 * El canal se guarda en el estado del bot, asi que sobrevive a un reinicio: el
 * bug del bot antiguo era justamente que `/set_alert_channel` escribia un
 * fichero que ningun modulo volvia a leer.
 */
import { PermissionFlagsBits, SlashCommandBuilder } from "discord.js";

import type { CommandDefinition } from "./types.ts";

/** Un id de canal de Discord es un copo de nieve. */
const SNOWFLAKE = /^\d{17,20}$/;

export const setChannelCommand: CommandDefinition = {
  data: new SlashCommandBuilder()
    .setName("set_channel")
    .setDescription("Fija el canal de publicacion del estado y crea o edita el mensaje")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addChannelOption((option) =>
      option.setName("canal").setDescription("Canal donde publicar (por defecto, el actual)"),
    ),

  async execute(interaction, context) {
    const channelId = interaction.getString("canal") ?? interaction.channelId;
    if (!SNOWFLAKE.test(channelId)) {
      await interaction.reply({
        content: `❌ ${channelId} no es un id de canal valido.`,
        ephemeral: true,
      });
      return;
    }

    await context.store.setStatusChannelId(channelId);
    context.scheduler.setChannel(channelId);
    const result = await context.scheduler.runOnce("manual");

    if (result.error !== null) {
      await interaction.reply({
        content: `❌ No se pudo publicar en <#${channelId}>: ${result.error}`,
        ephemeral: true,
      });
      return;
    }

    await interaction.reply({
      content: `✅ Canal fijado: <#${channelId}> · mensaje ${result.created ? "creado" : "actualizado"}`,
      ephemeral: true,
    });
  },
};
