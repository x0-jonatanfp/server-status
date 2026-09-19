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

/**
 * Una fila de recursos del mensaje (CPU, GPU, RAM o un volumen).
 *
 * La etiqueta y el emoji son configuracion porque el mensaje es del Dueno, no
 * del codigo; la temperatura se enlaza por el `name` de un sensor, de forma que
 * cada lectura viaja en su propia fila y no en una seccion aparte.
 */
export interface ResourceRowSettings {
  /** Etiqueta de la fila; se pinta en mayusculas (`NVME`). */
  label: string;
  /** Emoji que abre la fila (`💽`). */
  icon: string;
  /** `name` del sensor de temperatura que acompaña a la fila, si tiene. */
  temperature: string | null;
}

/** Fila de la GPU: ademas del sensor, de donde sale el uso. */
export interface GpuResourceSettings extends ResourceRowSettings {
  /**
   * Patron (con `*` admitido en un segmento) del fichero de uso:
   * `/sys/class/drm/card*\/device/gpu_busy_percent`. `null` = no se mide y la
   * fila sale sin barra ni porcentaje.
   */
  busyPercentPath: string | null;
}

/** Fila de un volumen: el punto de montaje exacto que se mide. */
export interface DiskResourceSettings extends ResourceRowSettings {
  mount: string;
}

/**
 * Las filas de recursos del mensaje, en su orden: CPU, GPU, RAM y los volumenes
 * del inventario tal como esten listados.
 */
export interface ResourceSettings {
  cpu: ResourceRowSettings;
  gpu: GpuResourceSettings;
  memory: ResourceRowSettings;
  disks: DiskResourceSettings[];
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
  resources: ResourceSettings;
  display: DisplaySettings;
  alerts: AlertSettings;
}
