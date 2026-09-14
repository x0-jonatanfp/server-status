/**
 * Una alerta por umbral.
 */
export type AlertSeverity = "warning" | "critical";

export interface Alert {
  /** Identificador estable del origen: `metric:cpu_percent`, `temperature:GPU`. */
  key: string;
  severity: AlertSeverity;
  title: string;
  detail: string;
}
