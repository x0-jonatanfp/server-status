/**
 * Validadores de configuracion.
 *
 * Los comparten el adaptador del `.env` y el del inventario. Todos fallan con
 * `ConfigError` y un mensaje que dice que clave esta mal, para que un typo no
 * pase silencioso como en el bot antiguo (que tenia variables de entorno que no
 * hacian nada).
 */

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export function fail(message: string): never {
  throw new ConfigError(message);
}

export function expectObject(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(`${path} debe ser un objeto`);
  }
  return value as Record<string, unknown>;
}

export function expectArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) {
    fail(`${path} debe ser una lista`);
  }
  return value;
}

export function expectString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    fail(`${path} debe ser un texto no vacio (recibido: ${describe(value)})`);
  }
  return value.trim();
}

export function expectNumber(
  value: unknown,
  path: string,
  bounds: { min?: number; max?: number } = {},
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail(`${path} debe ser un numero (recibido: ${describe(value)})`);
  }
  if (bounds.min !== undefined && value < bounds.min) {
    fail(`${path} debe ser >= ${bounds.min} (recibido: ${value})`);
  }
  if (bounds.max !== undefined && value > bounds.max) {
    fail(`${path} debe ser <= ${bounds.max} (recibido: ${value})`);
  }
  return value;
}

export function expectBoolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") {
    fail(`${path} debe ser true o false (recibido: ${describe(value)})`);
  }
  return value;
}

export function expectKnownKeys(
  object: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
): void {
  for (const key of Object.keys(object)) {
    if (!allowed.includes(key)) {
      fail(`${path}.${key} no es una clave conocida (admitidas: ${allowed.join(", ")})`);
    }
  }
}

export function describe(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  return String(value);
}
