/**
 * Caso de uso: recolectar la foto completa del sistema.
 *
 * Los puertos se lanzan en paralelo: el ciclo completo tarda lo que el mas
 * lento (las webs, con su timeout) y no la suma de todos. Ninguno de ellos
 * lanza: cada fuente degrada a `null` o a lista vacia, de forma que una caida
 * puntual se refleja en el mensaje en vez de tumbar la actualizacion.
 */
import type { StatusSnapshot } from "../domain/entities/status-snapshot.ts";
import type { BotStatusPort } from "../domain/ports/bot-status.ts";
import type { Fail2banPort } from "../domain/ports/fail2ban.ts";
import type { MetricsPort } from "../domain/ports/metrics.ts";
import type { ServiceStatusPort } from "../domain/ports/services.ts";
import type { TemperaturePort } from "../domain/ports/temperatures.ts";
import type { WebsiteProbePort } from "../domain/ports/websites.ts";

export interface CollectStatusPorts {
  metrics: MetricsPort;
  temperatures: TemperaturePort;
  services: ServiceStatusPort;
  websites: WebsiteProbePort;
  fail2ban: Fail2banPort;
  botStatus: BotStatusPort;
}

export async function collectStatus(ports: CollectStatusPorts): Promise<StatusSnapshot> {
  const [system, temperatures, services, websites, fail2ban, bot] = await Promise.all([
    ports.metrics.collect(),
    ports.temperatures.collect(),
    ports.services.collect(),
    ports.websites.probe(),
    ports.fail2ban.status(),
    ports.botStatus.status(),
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
