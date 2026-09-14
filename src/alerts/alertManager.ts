/**
 * Alertas por umbrales.
 *
 * Los umbrales salen del inventario: los de recursos y latencia del bloque
 * `alerts.thresholds` y los de temperatura del `warn`/`crit` de cada sensor.
 * Esto arregla el bug del bot antiguo, que buscaba la clave `cpu_temp` cuando
 * las metricas traian `cpu_temperature` y por eso no disparaba ninguna alerta de
 * temperatura.
 *
 * El cooldown es por metrica y gravedad, y no se reinicia al recuperarse: una
 * metrica que oscila alrededor del umbral avisa una vez y luego calla hasta que
 * pasa el cooldown. Cambiar de gravedad (aviso -> critico) si avisa al momento,
 * porque es una situacion distinta.
 */
import type { MetricKey, MetricThreshold } from "../config.ts";
import type { StatusSnapshot } from "../collectors/index.ts";
import { formatCelsius, formatMilliseconds, formatPercent } from "../render/format.ts";

export type AlertSeverity = "warning" | "critical";

export interface Alert {
  /** Identificador estable del origen: `metric:cpu_percent`, `temperature:GPU`. */
  key: string;
  severity: AlertSeverity;
  title: string;
  detail: string;
}

export interface AlertManagerOptions {
  cooldownMinutes: number;
  thresholds: Record<MetricKey, MetricThreshold>;
  /** Inyectable en los tests. */
  now?: () => number;
}

const METRIC_LABELS: Record<MetricKey, string> = {
  cpu_percent: "🧠 CPU",
  memory_percent: "💾 RAM",
  disk_percent: "💽 Disco",
  ping_ms: "📡 Latencia del bot",
};

export class AlertManager {
  private readonly options: AlertManagerOptions;
  private readonly lastSentAt = new Map<string, number>();

  constructor(options: AlertManagerOptions) {
    this.options = options;
  }

  /** Alertas que hay que enviar ahora (las que estan dentro del cooldown se omiten). */
  evaluate(snapshot: StatusSnapshot): Alert[] {
    const now = this.now();
    const cooldownMs = this.options.cooldownMinutes * 60_000;
    const emitted: Alert[] = [];

    for (const alert of collectAlerts(snapshot, this.options.thresholds)) {
      const cooldownKey = `${alert.key}:${alert.severity}`;
      const lastSent = this.lastSentAt.get(cooldownKey);
      if (lastSent !== undefined && now - lastSent < cooldownMs) continue;
      this.lastSentAt.set(cooldownKey, now);
      emitted.push(alert);
    }

    return emitted;
  }

  /** Olvida los cooldowns (util al cambiar de umbrales o en los tests). */
  reset(): void {
    this.lastSentAt.clear();
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
}

function collectAlerts(
  snapshot: StatusSnapshot,
  thresholds: Record<MetricKey, MetricThreshold>,
): Alert[] {
  const alerts: Alert[] = [];

  const metrics: Array<{ key: MetricKey; value: number | null }> = [
    { key: "cpu_percent", value: snapshot.system.cpuPercent },
    { key: "memory_percent", value: snapshot.system.memory?.percent ?? null },
    { key: "disk_percent", value: snapshot.system.disk?.percent ?? null },
    { key: "ping_ms", value: snapshot.bot.pingMs },
  ];

  for (const metric of metrics) {
    const threshold = thresholds[metric.key];
    if (metric.value === null || threshold === undefined) continue;
    const severity = severityOf(metric.value, threshold);
    if (severity === null) continue;

    const formatted =
      metric.key === "ping_ms" ? formatMilliseconds(metric.value) : formatPercent(metric.value);
    alerts.push({
      key: `metric:${metric.key}`,
      severity,
      title: `${METRIC_LABELS[metric.key]} fuera de rango`,
      detail: `${formatted} (aviso a partir de ${formatThreshold(metric.key, threshold.warn)}, crítico a partir de ${formatThreshold(metric.key, threshold.crit)})`,
    });
  }

  for (const reading of snapshot.temperatures) {
    if (reading.celsius === null) continue;
    const threshold: MetricThreshold = { warn: reading.warn, crit: reading.crit };
    const severity = severityOf(reading.celsius, threshold);
    if (severity === null) continue;

    alerts.push({
      key: `temperature:${reading.name}`,
      severity,
      title: `🌡️ ${reading.name} caliente`,
      detail: `${formatCelsius(reading.celsius)} (aviso a partir de ${formatCelsius(reading.warn)}, crítico a partir de ${formatCelsius(reading.crit)})`,
    });
  }

  return alerts;
}

function severityOf(value: number, threshold: MetricThreshold): AlertSeverity | null {
  if (value >= threshold.crit) return "critical";
  if (value >= threshold.warn) return "warning";
  return null;
}

function formatThreshold(key: MetricKey, value: number): string {
  return key === "ping_ms" ? formatMilliseconds(value) : formatPercent(value);
}
