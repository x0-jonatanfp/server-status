/**
 * Metricas de la maquina: CPU, GPU, RAM, volumenes y uptime.
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
  /**
   * Uso de la GPU en porcentaje. `null` si no se mide, si el fichero no existe
   * o si no se puede leer: nunca se inventa un numero.
   */
  gpuPercent: number | null;
  memory: ResourceUsage | null;
  /**
   * Uso de cada volumen del inventario que el sistema conoce. Los que no
   * aparecen en el sistema no estan aqui (y su fila sale sin datos); por eso se
   * buscan por `mount` y no por posicion.
   */
  disks: DiskUsage[];
  uptimeSeconds: number | null;
  os: OperatingSystemInfo | null;
}
