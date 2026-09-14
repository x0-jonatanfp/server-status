/**
 * El inventario tal como lo entiende el dominio.
 *
 * Los adaptadores de configuracion son los que traducen el YAML y el `.env` a
 * estas formas: el dominio no sabe que existe un fichero.
 */
import type { TemperatureSource } from "./temperature-reading.ts";

export interface WebsiteTarget {
  url: string;
  label: string;
}

export interface ServiceGroup {
  group: string;
  units: string[];
}

export interface TemperatureSensor {
  source: TemperatureSource;
  /** Etiqueta que se muestra en el mensaje (CPU, GPU, NVMe, Placa...). */
  name: string;
  warn: number;
  crit: number;
  /** Solo `hwmon`: nombre del chip en `/sys/class/hwmon/<hwmonN>/name`. */
  chip?: string;
  /** Solo `hwmon`: etiqueta del sensor (`tempN_label`). */
  label?: string;
  /** Solo `hwmon`: numero de sensor por defecto si no se encuentra la etiqueta. */
  index?: number;
  /** Solo `smartctl`: dispositivo a consultar. */
  device?: string;
}

export interface DisplayColors {
  ok: string;
  warning: string;
  critical: string;
}

/** Que se muestra en el mensaje y con que colores. */
export interface DisplaySettings {
  showGroups: boolean;
  showFail2banBreakdown: boolean;
  showPing: boolean;
  progressBarBlocks: number;
  colors: DisplayColors;
}

export type MetricKey = "cpu_percent" | "memory_percent" | "disk_percent" | "ping_ms";

export interface MetricThreshold {
  warn: number;
  crit: number;
}

/** Umbrales de alerta por metrica y cooldown entre avisos. */
export interface AlertSettings {
  cooldownMinutes: number;
  thresholds: Record<MetricKey, MetricThreshold>;
}

export interface Inventory {
  websites: WebsiteTarget[];
  services: ServiceGroup[];
  temperatures: TemperatureSensor[];
  display: DisplaySettings;
  alerts: AlertSettings;
}
