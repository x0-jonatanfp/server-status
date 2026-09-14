/**
 * Puerto de estado de unidades systemd, agrupadas segun el inventario.
 */
import type { ServiceGroupStatus } from "../entities/service-status.ts";

export interface ServiceStatusPort {
  collect(): Promise<ServiceGroupStatus[]>;
}
