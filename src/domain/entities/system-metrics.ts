/**
 * Metricas de la maquina: CPU, RAM, disco y uptime.
 */
export interface ResourceUsage {
  percent: number;
  usedBytes: number;
  totalBytes: number;
}

export interface DiskUsage extends ResourceUsage {
  mount: string;
}

export interface OperatingSystemInfo {
  hostname: string;
  /** Nombre de la distribucion, sin version (`Ubuntu`). */
  distro: string;
  /** Version de la distribucion (`24.04`). */
  release: string;
  kernel: string;
}

export interface SystemMetrics {
  /** `null` si la fuente falla: se muestra N/A en vez de romper el mensaje. */
  cpuPercent: number | null;
  memory: ResourceUsage | null;
  disk: DiskUsage | null;
  uptimeSeconds: number | null;
  os: OperatingSystemInfo | null;
}
