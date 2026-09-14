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
 */
import si from "systeminformation";

import type { SystemMetrics } from "../../domain/entities/system-metrics.ts";
import type { MetricsPort } from "../../domain/ports/metrics.ts";

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
  /** Punto de montaje que se mide (viene del `.env`). */
  diskMount: string;
  api?: SystemInformationApi;
}

export function createSystemMetricsPort(options: SystemMetricsOptions): MetricsPort {
  const api: SystemInformationApi = options.api ?? si;
  return {
    collect: () => collectSystemMetrics(api, options.diskMount),
  };
}

export async function collectSystemMetrics(
  api: SystemInformationApi,
  diskMount: string,
): Promise<SystemMetrics> {
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

  const filesystem = filesystems ? findMount(filesystems, diskMount) : null;
  const disk =
    filesystem === null
      ? null
      : {
          mount: filesystem.mount,
          percent: percentage(filesystem.used, filesystem.size),
          usedBytes: filesystem.used,
          totalBytes: filesystem.size,
        };

  return {
    cpuPercent: load ? load.currentLoad : null,
    memory: memoryUsage,
    disk,
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
 * Busca el punto de montaje pedido. Si no existe exactamente, usa el montaje
 * mas especifico del que cuelgue (p. ej. `/` para `/srv`).
 */
function findMount(
  entries: Array<{ mount: string; size: number; used: number }>,
  diskMount: string,
): { mount: string; size: number; used: number } | null {
  const exact = entries.find((entry) => entry.mount === diskMount);
  if (exact) return exact;

  const parents = entries
    .filter(
      (entry) =>
        entry.mount !== diskMount &&
        diskMount.startsWith(entry.mount === "/" ? "/" : `${entry.mount}/`),
    )
    .sort((a, b) => b.mount.length - a.mount.length);
  return parents[0] ?? null;
}

async function safe<T>(run: () => T | Promise<T>): Promise<T | null> {
  try {
    return await run();
  } catch {
    return null;
  }
}
