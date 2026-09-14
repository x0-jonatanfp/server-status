/**
 * Agregacion de todos los colectores en una sola foto del sistema.
 *
 * Los colectores se lanzan en paralelo: el ciclo completo tarda lo que el mas
 * lento (las webs, con su timeout) y no la suma de todos. Ninguno de ellos
 * lanza: cada fuente degrada a `null` o a una lista vacia, de forma que una
 * caida puntual se refleja en el mensaje en vez de tumbar la actualizacion.
 */
import type {
  ServiceGroupConfig,
  TemperatureConfig,
  WebsiteConfig,
} from "../config.ts";
import { collectFail2ban, type Fail2banOptions, type Fail2banStatus } from "./fail2ban.ts";
import { collectServices, type ServiceGroupStatus } from "./services.ts";
import { collectSystemMetrics, type SystemMetrics } from "./system.ts";
import { collectTemperatures, type TemperatureReading } from "./temperatures.ts";
import { collectWebsites, type WebsiteStatus } from "./websites.ts";

export type { Fail2banStatus, Fail2banJailStatus } from "./fail2ban.ts";
export type { ServiceGroupStatus, ServiceState, ServiceStatus } from "./services.ts";
export type { SystemMetrics, ResourceUsage, DiskUsage, OperatingSystemInfo } from "./system.ts";
export type { TemperatureReading } from "./temperatures.ts";
export type { WebsiteStatus } from "./websites.ts";

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

export interface CollectAllOptions {
  diskMount: string;
  httpTimeoutMs: number;
  websites: WebsiteConfig[];
  serviceGroups: ServiceGroupConfig[];
  temperatureSensors: TemperatureConfig[];
  fail2ban?: Fail2banOptions;
  /** Estado del bot en el momento de recolectar. */
  bot: () => BotStatus | Promise<BotStatus>;
}

export async function collectAll(options: CollectAllOptions): Promise<StatusSnapshot> {
  const [system, temperatures, services, websites, fail2ban, bot] = await Promise.all([
    collectSystemMetrics({ diskMount: options.diskMount }),
    collectTemperatures({ sensors: options.temperatureSensors }),
    collectServices({ groups: options.serviceGroups }),
    collectWebsites({ websites: options.websites, timeoutMs: options.httpTimeoutMs }),
    collectFail2ban(options.fail2ban ?? {}),
    options.bot(),
  ]);

  return {
    collectedAt: new Date(),
    system,
    temperatures,
    services,
    websites,
    fail2ban,
    bot,
  };
}
