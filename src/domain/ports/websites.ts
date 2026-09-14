/**
 * Puerto de comprobacion de webs: una entrada por web del inventario, con la
 * caida como dato (`up: false`) y nunca como excepcion.
 */
import type { WebsiteStatus } from "../entities/website-status.ts";

export interface WebsiteProbePort {
  probe(): Promise<WebsiteStatus[]>;
}
