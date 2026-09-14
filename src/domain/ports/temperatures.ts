/**
 * Puerto de temperaturas.
 *
 * Devuelve una lectura por cada sensor del inventario, en su orden. Un sensor
 * que falla sale con `celsius: null`, nunca con excepcion.
 */
import type { TemperatureReading } from "../entities/temperature-reading.ts";

export interface TemperaturePort {
  collect(): Promise<TemperatureReading[]>;
}
