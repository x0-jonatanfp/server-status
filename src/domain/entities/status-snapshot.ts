/**
 * Foto completa del sistema en un instante.
 */
import type { Fail2banStatus } from "./fail2ban-status.ts";
import type { ServiceGroupStatus } from "./service-status.ts";
import type { SystemMetrics } from "./system-metrics.ts";
import type { TemperatureReading } from "./temperature-reading.ts";
import type { WebsiteStatus } from "./website-status.ts";

/** Estado del propio bot, que no sale de la maquina sino del cliente. */
export interface BotStatus {
  /** Latencia del gateway en milisegundos. `null` si aun no se ha medido. */
  pingMs: number | null;
  uptimeSeconds: number;
}

export interface StatusSnapshot {
  collectedAt: Date;
  system: SystemMetrics;
  temperatures: TemperatureReading[];
  services: ServiceGroupStatus[];
  websites: WebsiteStatus[];
  fail2ban: Fail2banStatus;
  bot: BotStatus;
}
