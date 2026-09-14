/**
 * `/unban <ip>` — desbanea una IP en todas las carceles de fail2ban.
 *
 * La validacion de la IP vive en el adaptador de fail2ban: si no es valida no se
 * ejecuta ningun proceso, y aqui solo se informa.
 */
import { SlashCommandBuilder } from "discord.js";

import { InvalidIpError } from "../../fail2ban/client.ts";
import { ensureRole } from "./access.ts";
import type { CommandDefinition } from "./types.ts";

export const unbanCommand: CommandDefinition = {
  data: new SlashCommandBuilder()
    .setName("unban")
    .setDescription("Desbanea una IP de todas las carceles de fail2ban")
    .addStringOption((option) =>
      option.setName("ip").setDescription("IP a desbanear").setRequired(true),
    ),

  async execute(interaction, context) {
    if (!(await ensureRole(interaction, context))) return;

    const ip = interaction.getString("ip")?.trim() ?? "";
    if (ip === "") {
      await interaction.reply({ content: "❌ Indica la IP a desbanear.", ephemeral: true });
      return;
    }

    try {
      const result = await context.unban(ip);
      const failed = result.jails.filter((jail) => !jail.ok);
      const lines = [
        `✅ ${result.ip} desbaneada en ${result.jails.length - failed.length}/${result.jails.length} cárceles`,
      ];
      if (failed.length > 0) {
        lines.push(`⚠️ Con error: ${failed.map((jail) => jail.name).join(", ")}`);
      }
      await interaction.reply({ content: lines.join("\n"), ephemeral: true });
    } catch (error) {
      if (error instanceof InvalidIpError) {
        await interaction.reply({ content: `❌ ${error.message}`, ephemeral: true });
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      context.logger.error(`/unban ${ip} falló: ${message}`);
      await interaction.reply({
        content: `❌ No se pudo desbanear ${ip}: ${message}`,
        ephemeral: true,
      });
    }
  },
};
