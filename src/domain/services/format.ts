/**
 * Formateo de valores para mostrarlos.
 *
 * Es logica pura y la usan tanto el render como los comandos de alerta, asi que
 * vive en el dominio: no depende de Discord ni del sistema.
 *
 * Los numeros se redondean una sola vez (nada de `18.400000000000002 %`) y los
 * huecos se rellenan con `N/A` cuando la fuente no ha podido leer el dato.
 */

export const NOT_AVAILABLE = "N/A";

const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB"] as const;

/** Bytes en la unidad mas legible, con un decimal a partir de GB. */
export function formatBytes(bytes: number | null): string {
  if (bytes === null || !Number.isFinite(bytes) || bytes < 0) return NOT_AVAILABLE;
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const decimals = unit >= 3 ? 1 : 0;
  return `${value.toFixed(decimals)} ${BYTE_UNITS[unit]}`;
}

export function formatPercent(value: number | null, decimals = 1): string {
  if (value === null || !Number.isFinite(value)) return NOT_AVAILABLE;
  return `${value.toFixed(decimals)}%`;
}

export function formatCelsius(value: number | null, decimals = 1): string {
  if (value === null || !Number.isFinite(value)) return NOT_AVAILABLE;
  return `${value.toFixed(decimals)} °C`;
}

export function formatMilliseconds(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return NOT_AVAILABLE;
  return `${Math.round(value)} ms`;
}

/** Uptime en `4d 12h 07m`, o `12h 07m` si no llega al dia. */
export function formatUptime(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return NOT_AVAILABLE;
  const total = Math.floor(seconds);
  const days = Math.floor(total / 86_400);
  const hours = Math.floor((total % 86_400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const clock = `${String(hours).padStart(2, "0")}h ${String(minutes).padStart(2, "0")}m`;
  return days > 0 ? `${days}d ${clock}` : clock;
}

/** Hora local en `HH:MM:SS`. */
export function formatClock(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** Antiguedad de algo: `hace 12 s`, `hace 01h 05m`. */
export function formatAgo(seconds: number): string {
  const total = Math.max(0, seconds);
  return total < 60 ? `hace ${Math.round(total)} s` : `hace ${formatUptime(total)}`;
}

/** Intervalo entre actualizaciones, en la unidad que mejor se lea. */
export function formatInterval(seconds: number): string {
  if (seconds < 60) return `${seconds} s`;
  const minutes = seconds / 60;
  if (Number.isInteger(minutes)) return `${minutes} min`;
  return `${minutes.toFixed(1)} min`;
}

/** Barra de progreso de bloques, con el numero de bloques del inventario. */
export function progressBar(
  percent: number | null,
  blocks: number,
  filled = "🟪",
  empty = "⬜",
): string {
  if (percent === null || !Number.isFinite(percent)) return empty.repeat(blocks);
  const clamped = Math.min(100, Math.max(0, percent));
  const used = Math.round((clamped / 100) * blocks);
  return filled.repeat(used) + empty.repeat(blocks - used);
}
