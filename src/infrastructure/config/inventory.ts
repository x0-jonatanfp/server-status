/**
 * Inventario: que se monitoriza.
 *
 * Es un adaptador de configuracion, no una entidad: `js-yaml` y el esquema del
 * fichero viven aqui, y lo que sale es el `Inventory` del dominio, con nombres
 * en camelCase y validado clave a clave.
 *
 * YAML porque `mail-relay` ya usa `js-yaml` en este stack, y separado del `.env`
 * porque son listas con estructura, no secretos. Un inventario invalido aborta
 * el arranque diciendo que clave falla.
 */
import { readFileSync } from "node:fs";

// js-yaml 5 solo publica exports con nombre: no tiene export por defecto.
import { load as loadYaml } from "js-yaml";

import type {
  AlertSettings,
  DisplayColors,
  DisplaySettings,
  Inventory,
  MetricKey,
  MetricThreshold,
  ServiceGroup,
  TemperatureSensor,
  WebsiteTarget,
} from "../../domain/entities/inventory.ts";
import {
  expectArray,
  expectBoolean,
  expectKnownKeys,
  expectNumber,
  expectObject,
  expectString,
  fail,
} from "./validation.ts";

/** Claves del inventario admitidas. Cualquier otra aborta el arranque. */
const KNOWN_TOP_LEVEL_KEYS = [
  "websites",
  "services",
  "temperatures",
  "display",
  "alerts",
] as const;

const DEFAULT_DISPLAY: DisplaySettings = {
  showGroups: true,
  showFail2banBreakdown: true,
  showPing: true,
  progressBarBlocks: 5,
  colors: { ok: "#00FF41", warning: "#FFAA00", critical: "#FF0040" },
};

const METRIC_KEYS: readonly MetricKey[] = [
  "cpu_percent",
  "memory_percent",
  "disk_percent",
  "ping_ms",
];

const DEFAULT_ALERT_THRESHOLDS: Record<MetricKey, MetricThreshold> = {
  cpu_percent: { warn: 70, crit: 90 },
  memory_percent: { warn: 70, crit: 90 },
  disk_percent: { warn: 80, crit: 95 },
  ping_ms: { warn: 100, crit: 500 },
};

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function parseWebsites(value: unknown): WebsiteTarget[] {
  return expectArray(value, "inventory.websites").map((entry, i) => {
    const path = `inventory.websites[${i}]`;
    const object = expectObject(entry, path);
    expectKnownKeys(object, ["url", "label"], path);
    const url = expectString(object["url"], `${path}.url`);
    if (!/^https?:\/\//.test(url)) {
      fail(`${path}.url debe empezar por http:// o https:// (recibido: ${JSON.stringify(url)})`);
    }
    const label =
      object["label"] === undefined ? hostOf(url) : expectString(object["label"], `${path}.label`);
    return { url, label };
  });
}

function parseServices(value: unknown): ServiceGroup[] {
  const groups = expectArray(value, "inventory.services").map((entry, i) => {
    const path = `inventory.services[${i}]`;
    const object = expectObject(entry, path);
    expectKnownKeys(object, ["group", "units"], path);
    const group = expectString(object["group"], `${path}.group`);
    const units = expectArray(object["units"], `${path}.units`).map((unit, j) =>
      expectString(unit, `${path}.units[${j}]`),
    );
    if (units.length === 0) fail(`${path}.units no puede estar vacio`);
    return { group, units };
  });
  if (groups.length === 0) fail("inventory.services no puede estar vacio");
  return groups;
}

function parseTemperatures(value: unknown): TemperatureSensor[] {
  return expectArray(value, "inventory.temperatures").map((entry, i) => {
    const path = `inventory.temperatures[${i}]`;
    const object = expectObject(entry, path);
    expectKnownKeys(
      object,
      ["source", "name", "warn", "crit", "chip", "label", "index", "device"],
      path,
    );

    const source = expectString(object["source"], `${path}.source`);
    if (source !== "hwmon" && source !== "smartctl") {
      fail(`${path}.source debe ser "hwmon" o "smartctl" (recibido: ${JSON.stringify(source)})`);
    }
    const name = expectString(object["name"], `${path}.name`);
    const warn = expectNumber(object["warn"], `${path}.warn`, { min: 1, max: 120 });
    const crit = expectNumber(object["crit"], `${path}.crit`, { min: 1, max: 120 });
    if (warn >= crit) {
      fail(`${path}.warn (${warn}) debe ser menor que ${path}.crit (${crit})`);
    }

    const sensor: TemperatureSensor = { source, name, warn, crit };
    if (source === "hwmon") {
      sensor.chip = expectString(object["chip"], `${path}.chip`);
      if (object["label"] !== undefined) {
        sensor.label = expectString(object["label"], `${path}.label`);
      }
      if (object["index"] !== undefined) {
        sensor.index = expectNumber(object["index"], `${path}.index`, { min: 1 });
      }
      if (object["device"] !== undefined) {
        fail(`${path}.device solo vale con source "smartctl"`);
      }
    } else {
      sensor.device = expectString(object["device"], `${path}.device`);
      if (object["chip"] !== undefined || object["label"] !== undefined) {
        fail(`${path}.chip y ${path}.label solo valen con source "hwmon"`);
      }
    }
    return sensor;
  });
}

function parseColors(value: unknown): DisplayColors {
  const object = expectObject(value, "inventory.display.colors");
  expectKnownKeys(object, ["ok", "warning", "critical"], "inventory.display.colors");
  const colors = { ...DEFAULT_DISPLAY.colors };
  for (const key of ["ok", "warning", "critical"] as const) {
    if (object[key] === undefined) continue;
    const color = expectString(object[key], `inventory.display.colors.${key}`);
    if (!/^#[0-9a-fA-F]{6}$/.test(color)) {
      fail(
        `inventory.display.colors.${key} debe ser un color hex #RRGGBB (recibido: ${JSON.stringify(color)})`,
      );
    }
    colors[key] = color;
  }
  return colors;
}

function parseDisplay(value: unknown): DisplaySettings {
  if (value === undefined) {
    return { ...DEFAULT_DISPLAY, colors: { ...DEFAULT_DISPLAY.colors } };
  }
  const object = expectObject(value, "inventory.display");
  expectKnownKeys(
    object,
    ["show_groups", "show_fail2ban_breakdown", "show_ping", "progress_bar_blocks", "colors"],
    "inventory.display",
  );

  return {
    showGroups:
      object["show_groups"] === undefined
        ? DEFAULT_DISPLAY.showGroups
        : expectBoolean(object["show_groups"], "inventory.display.show_groups"),
    showFail2banBreakdown:
      object["show_fail2ban_breakdown"] === undefined
        ? DEFAULT_DISPLAY.showFail2banBreakdown
        : expectBoolean(
            object["show_fail2ban_breakdown"],
            "inventory.display.show_fail2ban_breakdown",
          ),
    showPing:
      object["show_ping"] === undefined
        ? DEFAULT_DISPLAY.showPing
        : expectBoolean(object["show_ping"], "inventory.display.show_ping"),
    progressBarBlocks:
      object["progress_bar_blocks"] === undefined
        ? DEFAULT_DISPLAY.progressBarBlocks
        : expectNumber(
            object["progress_bar_blocks"],
            "inventory.display.progress_bar_blocks",
            { min: 1, max: 10 },
          ),
    colors: object["colors"] === undefined ? { ...DEFAULT_DISPLAY.colors } : parseColors(object["colors"]),
  };
}

function parseAlerts(value: unknown): AlertSettings {
  const thresholds: Record<MetricKey, MetricThreshold> = {
    cpu_percent: { ...DEFAULT_ALERT_THRESHOLDS.cpu_percent },
    memory_percent: { ...DEFAULT_ALERT_THRESHOLDS.memory_percent },
    disk_percent: { ...DEFAULT_ALERT_THRESHOLDS.disk_percent },
    ping_ms: { ...DEFAULT_ALERT_THRESHOLDS.ping_ms },
  };
  if (value === undefined) return { cooldownMinutes: 30, thresholds };

  const object = expectObject(value, "inventory.alerts");
  expectKnownKeys(object, ["cooldown_minutes", "thresholds"], "inventory.alerts");

  const cooldownMinutes =
    object["cooldown_minutes"] === undefined
      ? 30
      : expectNumber(object["cooldown_minutes"], "inventory.alerts.cooldown_minutes", { min: 0 });

  if (object["thresholds"] !== undefined) {
    const raw = expectObject(object["thresholds"], "inventory.alerts.thresholds");
    expectKnownKeys(raw, METRIC_KEYS, "inventory.alerts.thresholds");
    for (const key of METRIC_KEYS) {
      if (raw[key] === undefined) continue;
      const path = `inventory.alerts.thresholds.${key}`;
      const entry = expectObject(raw[key], path);
      expectKnownKeys(entry, ["warn", "crit"], path);
      const warn = expectNumber(entry["warn"], `${path}.warn`, { min: 0 });
      const crit = expectNumber(entry["crit"], `${path}.crit`, { min: 0 });
      if (warn >= crit) {
        fail(`${path}.warn (${warn}) debe ser menor que ${path}.crit (${crit})`);
      }
      thresholds[key] = { warn, crit };
    }
  }

  return { cooldownMinutes, thresholds };
}

/** Valida el contenido ya parseado del inventario. */
export function parseInventory(raw: unknown, source = "inventory.yaml"): Inventory {
  const object = expectObject(raw, source);
  expectKnownKeys(object, KNOWN_TOP_LEVEL_KEYS, source);
  if (object["services"] === undefined) {
    fail(`${source}: falta la clave obligatoria services`);
  }
  return {
    websites: object["websites"] === undefined ? [] : parseWebsites(object["websites"]),
    services: parseServices(object["services"]),
    temperatures:
      object["temperatures"] === undefined ? [] : parseTemperatures(object["temperatures"]),
    display: parseDisplay(object["display"]),
    alerts: parseAlerts(object["alerts"]),
  };
}

/** Lee y valida `inventory.yaml`. */
export function loadInventory(path: string): Inventory {
  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      fail(`no existe el inventario ${path} (copialo de inventory.yaml.example)`);
    }
    fail(`no se puede leer el inventario ${path}: ${(error as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = loadYaml(content);
  } catch (error) {
    fail(`${path} no es YAML valido: ${(error as Error).message}`);
  }
  if (parsed === null || parsed === undefined) {
    fail(`${path} esta vacio`);
  }
  return parseInventory(parsed, path);
}
