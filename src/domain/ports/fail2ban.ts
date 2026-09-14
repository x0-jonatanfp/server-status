/**
 * Puerto de fail2ban: estado de las carceles y desbaneo.
 */
import type { Fail2banStatus, Fail2banUnbanResult } from "../entities/fail2ban-status.ts";

export interface Fail2banPort {
  status(): Promise<Fail2banStatus>;
  /** Lanza `InvalidIpError` si la IP no es valida, sin ejecutar nada. */
  unban(ip: string): Promise<Fail2banUnbanResult>;
}
