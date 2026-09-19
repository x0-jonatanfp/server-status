/**
 * Metricas del sistema con `systeminformation`.
 *
 * Por dos motivos medidos en el spike, en lugar de `psutil`:
 * `currentLoad()` no bloquea el event loop como `psutil.cpu_percent(interval=1)`
 * y `osInfo()` ya trae hostname, distro y kernel.
 *
 * El porcentaje de disco se calcula como `used / size`, no con el campo `use`
 * de systeminformation ni con el porcentaje de `df`: `use` mide
 * `used / (used + available)`, que en esta maquina da 39 % donde `used / size`
 * da 36 %. La cifra que se muestra es `used / size`, igual que el bot antiguo.
 *
 * Los volumenes son los del inventario y se buscan por punto de montaje exacto:
 * nada de adivinar un montaje padre. Un volumen que el sistema no conoce no
 * sale en `disks`, y su fila del mensaje queda sin datos.
 */
import si from "systeminformation";

import type { SystemMetrics } from "../../domain/entities/system-metrics.ts";
import type { MetricsPort } from "../../domain/ports/metrics.ts";
import { createGpuUsageReader, type GpuUsageReader } from "./gpu-usage.ts";

/** Subconjunto de `systeminformation` que se usa, inyectable en los tests. */
export interface SystemInformationApi {
  currentLoad(): Promise<{ currentLoad: number }>;
  mem(): Promise<{ total: number; available: number }>;
  fsSize(): Promise<Array<{ mount: string; size: number; used: number }>>;
  /** En systeminformation `time()` es sincrono. */
  time(): { uptime: number } | Promise<{ uptime: number }>;
  osInfo(): Promise<{ hostname: string; distro: string; release: string; kernel: string }>;
}

export interface SystemMetricsOptions {
  /** Puntos de montaje del inventario (`resources.disks[].mount`). */
  mounts: string[];
  /** Patron del fichero de uso de la GPU; `null` o ausente = no se mide. */
  gpuBusyPercentPath?: string | null;
  api?: SystemInformationApi;
  /** Lector del uso de GPU; por defecto lee `/sys`. */
  gpu?: GpuUsageReader;
}

export function createSystemMetricsPort(options: SystemMetricsOptions): MetricsPort {
  const api: SystemInformationApi = options.api ?? si;
  const gpu = options.gpu ?? createGpuUsageReader();
  return {
    collect: () => collectSystemMetrics({ ...options, api, gpu }),
  };
}

export async function collectSystemMetrics(
  options: SystemMetricsOptions,
): Promise<SystemMetrics> {
  const api: SystemInformationApi = options.api ?? si;
  const gpu = options.gpu ?? createGpuUsageReader();

  const [load, memory, filesystems, time, os] = await Promise.all([
    safe(() => api.currentLoad()),
    safe(() => api.mem()),
    safe(() => api.fsSize()),
    safe(() => api.time()),
    safe(() => api.osInfo()),
  ]);

  const memoryUsage =
    memory === null
      ? null
      : {
          // psutil calculaba el porcentaje como `total - available`, que es la
          // definicion que ve el usuario en el mensaje.
          percent: percentage(memory.total - memory.available, memory.total),
          usedBytes: memory.total - memory.available,
          totalBytes: memory.total,
        };

  return {
    cpuPercent: load ? load.currentLoad : null,
    gpuPercent: gpu.read(options.gpuBusyPercentPath ?? null),
    memory: memoryUsage,
    disks: selectDisks(filesystems ?? [], options.mounts),
    uptimeSeconds: time ? time.uptime : null,
    os: os
      ? { hostname: os.hostname, distro: os.distro, release: os.release, kernel: os.kernel }
      : null,
  };
}

function percentage(used: number, total: number): number {
  if (total <= 0) return 0;
  return (used / total) * 100;
}

/**
 * Uso de los volumenes del inventario, en el orden en que aparezcan en el
 * sistema. Se busca el mount exacto: un volumen que no este montado no se
 * sustituye por el de su padre.
 */
function selectDisks(
  entries: Array<{ mount: string; size: number; used: number }>,
  mounts: string[],
): SystemMetrics["disks"] {
  const disks: SystemMetrics["disks"] = [];
  for (const entry of entries) {
    if (!mounts.includes(entry.mount)) continue;
    if (disks.some((disk) => disk.mount === entry.mount)) continue;
    disks.push({
      mount: entry.mount,
      percent: percentage(entry.used, entry.size),
      usedBytes: entry.used,
      totalBytes: entry.size,
    });
  }
  return disks;
}

async function safe<T>(run: () => T | Promise<T>): Promise<T | null> {
  try {
    return await run();
  } catch {
    return null;
  }
}
