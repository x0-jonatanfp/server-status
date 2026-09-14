/**
 * Estado de fail2ban y resultado de un desbaneo.
 */
export interface Fail2banJailStatus {
  name: string;
  /** `null` si no se pudo consultar esa carcel. */
  banned: number | null;
}

export interface Fail2banStatus {
  /** `false` si el cliente no responde (servicio caido o sin permisos). */
  available: boolean;
  totalBanned: number;
  jails: Fail2banJailStatus[];
  error: string | null;
}

export interface Fail2banUnbanJail {
  name: string;
  ok: boolean;
  error: string | null;
}

export interface Fail2banUnbanResult {
  ip: string;
  jails: Fail2banUnbanJail[];
}
