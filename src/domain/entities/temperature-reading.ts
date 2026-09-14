/**
 * Una lectura de temperatura de un sensor del inventario.
 */
export type TemperatureSource = "hwmon" | "smartctl";

export interface TemperatureReading {
  /** Etiqueta que se muestra en el mensaje (CPU, GPU, NVMe, Placa...). */
  name: string;
  /** `null` si la fuente falla o la lectura es imposible. */
  celsius: number | null;
  warn: number;
  crit: number;
  source: TemperatureSource;
  /** Origen concreto, para el log: `k10temp Tctl` o `/dev/sda`. */
  detail: string;
}
