/**
 * Metricas de la maquina: CPU, RAM, disco y uptime.
 *
 * Se usa `systeminformation` en lugar de `psutil` por dos motivos medidos en el
 * spike: `currentLoad()` no bloquea el event loop como
 * `psutil.cpu_percent(interval=1)` y `osInfo()` ya trae hostname, distro y
 * kernel.
 *
 * El porcentaje de disco se calcula como `used / size`, no con el campo `use`
 * de systeminformation ni con el porcentaje de `df`: `use` mide
 * `used / (used + available)`, que en esta maquina da 39 % donde `used / size`
 * da 36 %. La cifra que se muestra es `used / size`, igual que el bot antiguo.
 */
import si from "systeminformation";

/** Subconjunto de `systeminformation` que se usa, inyectable en los tests. */
export interface SystemInformationApi {
  currentLoad(): Promise<{ currentLoad: number }>;
  mem(): Promise<{ total: number; available: number }>;
  fsSize(): Promise<Array<{ mount: string; size: number; used: number }>>;
  /** En systeminformation `time()` es sincrono. */
  time(): { uptime: number } | Promise<{ uptime: number }>;
  osInfo(): Promise<{ hostname: string; distro: string; release: string; kernel: string }>;
}

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

export interface CollectSystemOptions {
  /** Punto de montaje que se mide (viene del `.env`). */
  diskMount: string;
  api?: SystemInformationApi;
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

/**
 * Recolecta las metricas del sistema. Cada fuente falla de forma aislada:
 * si una no responde, su campo queda a `null` y el resto se sigue mostrando.
 */
export async function collectSystemMetrics(
  options: CollectSystemOptions,
): Promise<SystemMetrics> {
  const api: SystemInformationApi = options.api ?? si;

  const [load, memory, filesystems, time, os] = await Promise.all([
    safe(() => api.currentLoad()),
    safe(() => api.mem()),
    safe(() => api.fsSize()),
    safe(() => api.time()),
    safe(() => api.osInfo()),
  ]);

  const memoryUsage: ResourceUsage | null = memory
    ? {
        // psutil calculaba el porcentaje como `total - available`, que es la
        // definicion que ve el usuario en el mensaje.
        percent: percentage(memory.total - memory.available, memory.total),
        usedBytes: memory.total - memory.available,
        totalBytes: memory.total,
      }
    : null;

  const filesystem = filesystems ? findMount(filesystems, options.diskMount) : null;
  const disk: DiskUsage | null = filesystem
    ? {
        mount: filesystem.mount,
        percent: percentage(filesystem.used, filesystem.size),
        usedBytes: filesystem.used,
        totalBytes: filesystem.size,
      }
    : null;

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

async function safe<T>(run: () => T | Promise<T>): Promise<T | null> {
  try {
    return await run();
  } catch {
    return null;
  }
}
