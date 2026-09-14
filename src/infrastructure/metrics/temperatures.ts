/**
 * Adaptador del puerto de temperaturas: reparte los sensores del inventario
 * entre hwmon y smartctl y devuelve la lectura ya filtrada por el dominio.
 *
 * Un sensor que falla no impide leer los demas: sale con `celsius: null`.
 */
import type { TemperatureSensor } from "../../domain/entities/inventory.ts";
import type { TemperatureReading } from "../../domain/entities/temperature-reading.ts";
import type { TemperaturePort } from "../../domain/ports/temperatures.ts";
import { normalizeReading } from "../../domain/services/temperatures.ts";
import {
  createHwmonTemperatureReader,
  type HwmonTemperatureReader,
} from "./hwmon-temperatures.ts";
import {
  createSmartctlTemperatureReader,
  type SmartctlTemperatureReader,
} from "./smartctl-temperatures.ts";

export interface TemperaturePortOptions {
  sensors: TemperatureSensor[];
  hwmon?: HwmonTemperatureReader;
  smartctl?: SmartctlTemperatureReader;
}

export function createTemperaturePort(options: TemperaturePortOptions): TemperaturePort {
  const hwmon = options.hwmon ?? createHwmonTemperatureReader();
  const smartctl = options.smartctl ?? createSmartctlTemperatureReader();

  return {
    async collect(): Promise<TemperatureReading[]> {
      // Los hwmon se leen en una sola pasada y los smartctl en paralelo, pero el
      // resultado se devuelve en el orden del inventario.
      const hwmonSensors = options.sensors.filter((sensor) => sensor.source === "hwmon");
      const raw = new Map<TemperatureSensor, number | null>();

      const hwmonValues = hwmon.read(hwmonSensors);
      hwmonSensors.forEach((sensor, index) => {
        raw.set(sensor, hwmonValues[index] ?? null);
      });

      await Promise.all(
        options.sensors
          .filter((sensor) => sensor.source === "smartctl")
          .map(async (sensor) => {
            raw.set(sensor, await smartctl.read(sensor));
          }),
      );

      return options.sensors.map((sensor) => ({
        name: sensor.name,
        warn: sensor.warn,
        crit: sensor.crit,
        source: sensor.source,
        detail: describeSensor(sensor),
        celsius: normalizeReading(raw.get(sensor) ?? null),
      }));
    },
  };
}

/** Origen concreto del sensor, para el log. */
export function describeSensor(sensor: TemperatureSensor): string {
  if (sensor.source === "smartctl") return sensor.device ?? "?";
  const index = sensor.label ?? `temp${sensor.index ?? 1}`;
  return `${sensor.chip ?? "?"} ${index}`;
}
