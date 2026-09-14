/**
 * Puerto del estado del propio bot (latencia del gateway y uptime del proceso).
 * Es lo unico que el snapshot saca de fuera de la maquina, y va detras de un
 * puerto para que los tests no necesiten un cliente de Discord.
 */
import type { BotStatus } from "../entities/status-snapshot.ts";

export interface BotStatusPort {
  /** El estado del bot es local (el cliente ya lo tiene en memoria). */
  status(): BotStatus;
}
