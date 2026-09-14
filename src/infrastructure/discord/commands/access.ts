/**
 * Control de acceso de los comandos.
 *
 * Discord solo sabe filtrar por permisos, no por nombre de rol, y el inventario
 * del bot antiguo usaba roles (`[ServerManager],[LoCo+]`), asi que los comandos
 * de consulta y de desbaneo comprueban los roles a mano. Los de administracion
 * se limitan con `setDefaultMemberPermissions(Administrator)` en el propio
 * comando, que es lo que Discord aplica de verdad.
 */
import type { CommandContext, CommandInteraction } from "./types.ts";

/** `true` si la lista de roles configurada esta vacia o hay coincidencia. */
export function hasRequiredRole(roleNames: string[], requiredRoles: string[]): boolean {
  if (requiredRoles.length === 0) return true;
  return roleNames.some((role) => requiredRoles.includes(role));
}

/** Texto de denegacion, diciendo que roles valen. */
export function deniedMessage(requiredRoles: string[]): string {
  return `❌ No tienes permiso para usar este comando. Roles admitidos: ${requiredRoles.join(", ")}`;
}

/** Rechaza el comando y avisa si quien invoca no tiene ninguno de los roles. */
export async function ensureRole(
  interaction: CommandInteraction,
  context: CommandContext,
): Promise<boolean> {
  const requiredRoles = context.config.requiredRoles;
  if (hasRequiredRole(interaction.roleNames(), requiredRoles)) return true;

  context.logger.warn(`comando denegado: faltan roles (${requiredRoles.join(", ")})`);
  await interaction.reply({ content: deniedMessage(requiredRoles), ephemeral: true });
  return false;
}
