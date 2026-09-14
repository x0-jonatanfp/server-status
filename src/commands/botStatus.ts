/**
 * `/botstatus` — estado del propio bot: bucle, ultima publicacion y latencia.
 *
 * Sirve para responder a "¿esta actualizandose?" sin tener que mirar el journal.
 */
import { PermissionFlagsBits, SlashCommandBuilder } from "discord.js";

import {
  formatAgo,
  formatClock,
  formatInterval,
  formatMilliseconds,
  formatUptime,
} from "../render/format.ts";
import type { CommandDefinition } from "./types.ts";

export const botStatusCommand: CommandDefinition = {
  data: new SlashCommandBuilder()
    .setName("botstatus")
    .setDescription("Estado del bot: bucle, latencia y ultima publicacion")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  async execute(interaction, context) {
    const now = Date.now();
    const last = context.scheduler.lastRun;
    const lines = [`🤖 ${context.config.botDisplayName} v${context.version}`];

    lines.push(
      `Bucle: cada ${formatInterval(context.config.updateIntervalSeconds)} · canal <#${context.scheduler.channelId}>`,
    );

    if (last === null) {
      lines.push("Última publicación: todavía ninguna");
    } else {
      const action = last.created ? "mensaje creado" : "mensaje editado";
      lines.push(
        `Última publicación: ${formatClock(last.at)} (${formatAgo((now - last.at.getTime()) / 1000)}) · ${action} · ${formatMilliseconds(last.durationMs)}`,
      );
      if (last.error !== null) lines.push(`⚠️ Último ciclo con error: ${last.error}`);
    }

    lines.push(`Latencia del gateway: ${formatMilliseconds(context.gatewayPingMs())}`);
    lines.push(
      `En marcha desde: ${formatClock(context.startedAt)} (${formatUptime((now - context.startedAt.getTime()) / 1000)})`,
    );

    await interaction.reply({ content: lines.join("\n"), ephemeral: true });
  },
};
