/**
 * Semaforos y color de acento.
 *
 * Toda decision de color pasa por aqui. Los umbrales no viven en el codigo:
 * los de recursos salen de `alerts.thresholds` del inventario y los de
 * temperatura del `warn`/`crit` de cada sensor, porque un unico umbral global
 * no sirve (la GPU avisa a 91 C y el NVMe a 79.8 C).
 */
import type { DisplayColors, MetricThreshold } from "../entities/inventory.ts";
import type { ServiceState } from "../entities/service-status.ts";

export type Level = "ok" | "warning" | "critical" | "unknown";

const RANK: Record<Level, number> = { unknown: 0, ok: 1, warning: 2, critical: 3 };

function levelFrom(value: number, warn: number, crit: number): Level {
  if (value >= crit) return "critical";
  if (value >= warn) return "warning";
  return "ok";
}

/** Nivel de una metrica de recursos o de la latencia. */
export function levelFromThreshold(
  value: number | null,
  threshold: MetricThreshold | undefined,
): Level {
  if (value === null || threshold === undefined) return "unknown";
  return levelFrom(value, threshold.warn, threshold.crit);
}

/** Nivel de una temperatura, con los umbrales de su propio sensor. */
export function levelFromTemperature(
  celsius: number | null,
  warn: number,
  crit: number,
): Level {
  if (celsius === null) return "unknown";
  return levelFrom(celsius, warn, crit);
}

/**
 * Nivel de una unidad systemd: caida es critico y lo que no se puede confirmar
 * en marcha (parada, desconocida o arrancando) es aviso.
 */
export function levelFromServiceState(state: ServiceState): Level {
  switch (state) {
    case "active":
    case "reloading":
      return "ok";
    case "failed":
      return "critical";
    default:
      return "warning";
  }
}

export function levelFromWebsite(up: boolean): Level {
  return up ? "ok" : "warning";
}

/**
 * Nivel global del mensaje: el peor de todos. `unknown` solo cuenta cuando no
 * hay ninguna lectura fiable, para que un sensor que no se puede leer (p. ej.
 * smartctl sin permisos) no deje el mensaje en ambar para siempre.
 */
export function worstLevel(levels: Level[]): Level {
  const known = levels.filter((level) => level !== "unknown");
  if (known.length === 0) return levels.length > 0 ? "warning" : "ok";
  return known.reduce((worst, level) => (RANK[level] > RANK[worst] ? level : worst), "ok");
}

/** Emoji del estado global (el que abre el mensaje y el color de acento). */
export function levelEmoji(level: Level): string {
  switch (level) {
    case "critical":
      return "🔴";
    case "warning":
      return "🟠";
    default:
      return "🟢";
  }
}

/** Emoji de una linea concreta: las correctas no se marcan. */
export function levelMark(level: Level): string {
  switch (level) {
    case "critical":
      return "❌";
    case "warning":
      return "⚠️";
    case "unknown":
      return "❔";
    default:
      return "✅";
  }
}

/** Emoji de una unidad systemd, para distinguir "parada" de "no existe". */
export function stateMark(state: ServiceState): string {
  switch (state) {
    case "active":
    case "reloading":
      return "✅";
    case "failed":
      return "❌";
    case "unknown":
      return "❔";
    default:
      return "⚠️";
  }
}

/** Convierte `#RRGGBB` en el entero que espera el acento del Container. */
export function accentColor(level: Level, colors: DisplayColors): number {
  const hex =
    level === "critical" ? colors.critical : level === "warning" ? colors.warning : colors.ok;
  return Number.parseInt(hex.slice(1), 16);
}
