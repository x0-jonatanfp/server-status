/**
 * Puerto de metricas de la maquina (CPU, RAM, disco, uptime).
 *
 * Los adaptadores que lo implementan son los unicos que tocan el sistema; el
 * caso de uso y los tests trabajan contra esta interfaz.
 */
import type { SystemMetrics } from "../entities/system-metrics.ts";

export interface MetricsPort {
  collect(): Promise<SystemMetrics>;
}
