/**
 * Uso de la GPU, leido del kernel.
 *
 * La tarjeta no siempre es `card0` (en esta maquina el amdgpu es `card1`), asi
 * que el inventario declara un patron y aqui se expande contra `/sys`. Si el
 * fichero no existe o no se puede leer se devuelve `null`: la fila del mensaje
 * sale sin barra y sin porcentaje, nunca con un numero inventado.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Fuente del uso de GPU, inyectable en los tests. */
export interface GpuUsageReader {
  /** Porcentaje de uso, o `null` si el patron no apunta a nada legible. */
  read(pattern: string | null): number | null;
}

export function createGpuUsageReader(): GpuUsageReader {
  return { read: readGpuBusyPercent };
}

/** Lee el primer fichero que case con el patron y contenga un porcentaje. */
export function readGpuBusyPercent(pattern: string | null): number | null {
  if (pattern === null) return null;

  for (const path of expandPathPattern(pattern)) {
    let raw: string;
    try {
      raw = readFileSync(path, "utf8");
    } catch {
      // Sin fichero (o sin permisos) se prueba el siguiente candidato.
      continue;
    }
    const value = Number(raw.trim());
    if (!Number.isFinite(value)) continue;
    return Math.min(100, Math.max(0, value));
  }

  return null;
}

/**
 * Expande un patron absoluto que puede llevar `*` en uno o varios segmentos
 * (`/sys/class/drm/card*\/device/gpu_busy_percent`) a las rutas que existen de
 * verdad, ordenadas. Un segmento sin `*` no se comprueba: se encadena tal cual,
 * de forma que un fichero que no existe simplemente no se puede leer luego.
 */
export function expandPathPattern(pattern: string): string[] {
  if (!pattern.startsWith("/")) return [];

  let paths = ["/"];
  for (const segment of pattern.split("/").filter((part) => part !== "")) {
    const next: string[] = [];
    for (const base of paths) {
      if (!segment.includes("*")) {
        next.push(join(base, segment));
        continue;
      }
      const matcher = segmentToRegExp(segment);
      let entries: string[];
      try {
        entries = readdirSync(base).sort();
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (matcher.test(entry)) next.push(join(base, entry));
      }
    }
    paths = next;
  }
  return paths;
}

/** `card*` -> `^card.*$`, escapando lo que en regex no es comodin. */
function segmentToRegExp(segment: string): RegExp {
  const escaped = segment.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}
