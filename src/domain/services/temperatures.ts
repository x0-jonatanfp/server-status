/**
 * Que es una temperatura plausible.
 *
 * Es una regla del dominio, no del sistema: cualquier sensor, venga de hwmon o
 * de smartctl, se filtra igual. El rango 1-120 C es imprescindible en esta
 * maquina: el `it8792` expone un termistor desconectado que reporta -55 C y el
 * NVMe declara maximos de 65261 C. Sin el filtro el mensaje mostraria basura.
 */
export const MIN_VALID_CELSIUS = 1;
export const MAX_VALID_CELSIUS = 120;

/** Descarta lecturas imposibles y redondea a un decimal. */
export function normalizeReading(celsius: number | null | undefined): number | null {
  if (typeof celsius !== "number" || !Number.isFinite(celsius)) return null;
  if (celsius < MIN_VALID_CELSIUS || celsius > MAX_VALID_CELSIUS) return null;
  return Math.round(celsius * 10) / 10;
}
