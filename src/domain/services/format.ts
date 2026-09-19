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

/**
 * Barra de progreso de bloques, con el numero de bloques del inventario.
 *
 * Los bloques son caracteres de dibujo (`█` / `░`), no emoji: los emoji (el
 * `🟪`/`⬜` anterior) no tienen ancho estable en Discord y desalinean todo lo
 * que va detras. Como estos caracteres son de ancho fijo, la barra ocupa
 * siempre `blocks` columnas pase lo que pase.
 */
export function progressBar(
  percent: number | null,
  blocks: number,
  filled = FILLED_BLOCK,
  empty = EMPTY_BLOCK,
): string {
  if (percent === null || !Number.isFinite(percent)) return empty.repeat(blocks);
  const clamped = Math.min(100, Math.max(0, percent));
  const used = Math.round((clamped / 100) * blocks);
  return filled.repeat(used) + empty.repeat(blocks - used);
}

/** Bloque lleno y bloque vacio de las barras (no son emoji: ancho estable). */
export const FILLED_BLOCK = "█";
export const EMPTY_BLOCK = "░";

/**
 * Ancho de un texto en columnas, que es lo que importa al alinear.
 *
 * En un bloque de codigo los caracteres de dibujo y el ASCII ocupan una
 * columna, pero los emoji (✅, ❌, ⚠️, ❔) ocupan dos. Los selectores de
 * variacion y los ZWJ no ocupan nada. Asi el empaquetado de las listas no se
 * pasa del ancho por contar un emoji como un solo caracter.
 */
export function displayWidth(text: string): number {
  let width = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code === 0xfe0f || code === 0x200d) continue;
    width += isWideCodePoint(code) ? 2 : 1;
  }
  return width;
}

/** Rangos de anchura doble (CJK y emoji). */
function isWideCodePoint(code: number): boolean {
  return (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2600 && code <= 0x27bf) ||
    (code >= 0x2b00 && code <= 0x2bff) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe4f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f000 && code <= 0x1faff)
  );
}

/**
 * Reparte entradas en lineas sin pasarse de `maxWidth` columnas.
 *
 * Discord parte las lineas donde le da la gana, y con listas largas eso deja
 * el emoji de estado de una entrada al final de una linea y el nombre en la
 * siguiente. Empaquetando aqui, cada entrada es un bloque indivisible y el
 * salto lo decide el bot. Una entrada que no quepa sola ocupa su propia linea:
 * antes romper la linea que romper la entrada.
 */
export function packEntries(
  entries: readonly string[],
  options: { maxWidth: number; separator?: string; indent?: string },
): string[] {
  const separator = options.separator ?? " ";
  const indent = options.indent ?? "";
  const lines: string[] = [];
  let current = "";

  for (const entry of entries) {
    if (current === "") {
      current = entry;
      continue;
    }
    const candidate = `${current}${separator}${entry}`;
    if (displayWidth(indent + candidate) > options.maxWidth) {
      lines.push(indent + current);
      current = entry;
    } else {
      current = candidate;
    }
  }
  if (current !== "") lines.push(indent + current);
  return lines;
}
