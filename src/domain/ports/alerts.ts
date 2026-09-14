/**
 * Puerto de notificacion de alertas: el adaptador decide por donde salen
 * (canal de Discord, por ahora).
 */
import type { Alert } from "../entities/alert.ts";

export interface AlertNotifierPort {
  notify(alerts: Alert[]): Promise<void>;
}
