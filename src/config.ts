/**
 * Carga y validacion de la configuracion.
 *
 * Regla del proyecto: ningun canal, rol, web, servicio, sensor, umbral, color
 * ni intervalo hardcodeado en el codigo. Los secretos y los valores simples
 * viven en el `.env`; el inventario (listas con estructura) vive en
 * `inventory.yaml`.
 *
 * Todo se valida al arrancar: si una variable falta o no parsea, o si una clave
 * del inventario esta mal puesta, el proceso aborta diciendo cual es. El bug
 * del bot antiguo (variables de entorno que no hacian nada) no se puede
 * repetir; por eso `loadConfig` devuelve un objeto tipado y no muta el proceso.
 */
import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

import dotenv from "dotenv";
// js-yaml 5 solo publica exports con nombre: no tiene export por defecto.
import { load as loadYaml } from "js-yaml";

import { DEFAULT_LOG_FILE, DEFAULT_LOG_LEVEL } from "./logger.ts";

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

function fail(message: string): never {
  throw new ConfigError(message);
}

export type ActivityTypeName =
  | "Playing"
  | "Streaming"
  | "Listening"
  | "Watching"
  | "Custom"
  | "Competing";

export const ACTIVITY_TYPE_NAMES: readonly ActivityTypeName[] = [
  "Playing",
  "Streaming",
  "Listening",
  "Watching",
  "Custom",
  "Competing",
];

export interface ActivityConfig {
  type: ActivityTypeName;
  /** Nombre de la actividad (`name` del objeto de presencia). */
  name: string;
  /** Con `Custom` se muestra como estado personalizado del bot. */
  state: string | null;
  /** Solo se valida con `Streaming`, y solo Twitch/YouTube. */
  url: string | null;
}

export interface AppConfig {
  discordToken: string;
  botDisplayName: string;
  /** Dominio o nombre publico del host, si se quiere mostrar junto al SO. */
  hostLabel: string | null;
  activity: ActivityConfig;
  statusChannelId: string;
  alertChannelId: string | null;
  guildId: string | null;
  requiredRoles: string[];
  updateIntervalSeconds: number;
  httpTimeoutMs: number;
  diskMount: string;
  statePath: string;
  inventoryPath: string;
  logFile: string | null;
  logLevel: string;
  sudoPath: string;
  fail2banClientPath: string;
}

export interface WebsiteConfig {
  url: string;
  label: string;
}

export interface ServiceGroupConfig {
  group: string;
  units: string[];
}

export type TemperatureSource = "hwmon" | "smartctl";

export interface TemperatureConfig {
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

export interface DisplayConfig {
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

export interface AlertsConfig {
  cooldownMinutes: number;
  thresholds: Record<MetricKey, MetricThreshold>;
}

export interface Inventory {
  websites: WebsiteConfig[];
  services: ServiceGroupConfig[];
  temperatures: TemperatureConfig[];
  display: DisplayConfig;
  alerts: AlertsConfig;
}

export interface LoadedConfig {
  app: AppConfig;
  inventory: Inventory;
}

const DEFAULT_INVENTORY_PATH = "inventory.yaml";
const DEFAULT_STATE_PATH = "data/state.json";
const DEFAULT_UPDATE_INTERVAL_SECONDS = 300;
const DEFAULT_HTTP_TIMEOUT_MS = 8000;
const DEFAULT_DISK_MOUNT = "/";
const DEFAULT_SUDO_PATH = "/usr/bin/sudo";
const DEFAULT_FAIL2BAN_CLIENT_PATH = "/usr/bin/fail2ban-client";

/** Claves del inventario admitidas. Cualquier otra aborta el arranque. */
const KNOWN_TOP_LEVEL_KEYS = [
  "websites",
  "services",
  "temperatures",
  "display",
  "alerts",
] as const;

// --- Validadores genericos -------------------------------------------------

function expectObject(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(`${path} debe ser un objeto`);
  }
  return value as Record<string, unknown>;
}

function expectArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) {
    fail(`${path} debe ser una lista`);
  }
  return value;
}

function expectString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    fail(`${path} debe ser un texto no vacio (recibido: ${describe(value)})`);
  }
  return value.trim();
}

function expectNumber(
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

function expectBoolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") {
    fail(`${path} debe ser true o false (recibido: ${describe(value)})`);
  }
  return value;
}

function expectKnownKeys(
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

function describe(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  return String(value);
}

// --- Variables de entorno --------------------------------------------------

function readEnv(
  env: Record<string, string | undefined>,
  key: string,
): string | undefined {
  const raw = env[key];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed === "" ? undefined : trimmed;
}

function requiredEnv(env: Record<string, string | undefined>, key: string): string {
  return readEnv(env, key) ?? fail(`falta la variable obligatoria ${key} en el .env`);
}

function optionalEnv(env: Record<string, string | undefined>, key: string): string | null {
  return readEnv(env, key) ?? null;
}

function intEnv(
  env: Record<string, string | undefined>,
  key: string,
  fallback: number,
  bounds: { min?: number; max?: number } = {},
): number {
  const raw = readEnv(env, key);
  if (raw === undefined) return fallback;
  if (!/^-?\d+$/.test(raw)) {
    fail(`${key} debe ser un numero entero (recibido: ${JSON.stringify(raw)})`);
  }
  return expectNumber(Number(raw), key, bounds);
}

/** Un id de Discord es un copo de nieve: 17 a 20 digitos. */
function snowflakeEnv(
  env: Record<string, string | undefined>,
  key: string,
  required: true,
): string;
function snowflakeEnv(
  env: Record<string, string | undefined>,
  key: string,
  required: false,
): string | null;
function snowflakeEnv(
  env: Record<string, string | undefined>,
  key: string,
  required: boolean,
): string | null {
  const raw = required ? requiredEnv(env, key) : optionalEnv(env, key);
  if (raw === null) return null;
  if (!/^\d{17,20}$/.test(raw)) {
    fail(`${key} debe ser un id de Discord (17-20 digitos, recibido: ${JSON.stringify(raw)})`);
  }
  return raw;
}

/**
 * Acepta `[Rol A],[Rol B]` (formato del bot antiguo) o `Rol A, Rol B`.
 * Devuelve la lista sin corchetes ni espacios sobrantes.
 */
export function parseRequiredRoles(raw: string | undefined): string[] {
  if (!raw || raw.trim() === "") return [];
  const bracketed = raw.match(/\[([^\]]*)\]/g);
  const parts = bracketed
    ? bracketed.map((chunk) => chunk.slice(1, -1))
    : raw.split(",");
  return parts.map((part) => part.trim()).filter((part) => part !== "");
}

function parseActivityType(raw: string | undefined): ActivityTypeName {
  if (raw === undefined) return "Custom";
  const found = ACTIVITY_TYPE_NAMES.find((name) => name.toLowerCase() === raw.toLowerCase());
  return found ?? fail(`BOT_ACTIVITY_TYPE debe ser uno de: ${ACTIVITY_TYPE_NAMES.join(", ")}`);
}

// --- Inventario ------------------------------------------------------------

function parseWebsites(value: unknown): WebsiteConfig[] {
  return expectArray(value, "inventory.websites").map((entry, i) => {
    const path = `inventory.websites[${i}]`;
    const object = expectObject(entry, path);
    expectKnownKeys(object, ["url", "label"], path);
    const url = expectString(object["url"], `${path}.url`);
    if (!/^https?:\/\//.test(url)) {
      fail(`${path}.url debe empezar por http:// o https:// (recibido: ${JSON.stringify(url)})`);
    }
    const label = object["label"] === undefined ? hostOf(url) : expectString(object["label"], `${path}.label`);
    return { url, label };
  });
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function parseServices(value: unknown): ServiceGroupConfig[] {
  const groups = expectArray(value, "inventory.services").map((entry, i) => {
    const path = `inventory.services[${i}]`;
    const object = expectObject(entry, path);
    expectKnownKeys(object, ["group", "units"], path);
    const group = expectString(object["group"], `${path}.group`);
    const units = expectArray(object["units"], `${path}.units`).map((unit, j) =>
      expectString(unit, `${path}.units[${j}]`),
    );
    if (units.length === 0) {
      fail(`${path}.units no puede estar vacio`);
    }
    return { group, units };
  });
  if (groups.length === 0) {
    fail("inventory.services no puede estar vacio");
  }
  return groups;
}

function parseTemperatures(value: unknown): TemperatureConfig[] {
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
    // El rango 1-120 C es el que descarta las lecturas imposibles del hardware
    // (it8792 a -55 C, maximos declarados de 65261 C).
    const warn = expectNumber(object["warn"], `${path}.warn`, { min: 1, max: 120 });
    const crit = expectNumber(object["crit"], `${path}.crit`, { min: 1, max: 120 });
    if (warn >= crit) {
      fail(`${path}.warn (${warn}) debe ser menor que ${path}.crit (${crit})`);
    }

    const config: TemperatureConfig = { source, name, warn, crit };
    if (source === "hwmon") {
      config.chip = expectString(object["chip"], `${path}.chip`);
      if (object["label"] !== undefined) {
        config.label = expectString(object["label"], `${path}.label`);
      }
      if (object["index"] !== undefined) {
        config.index = expectNumber(object["index"], `${path}.index`, { min: 1 });
      }
      if (object["device"] !== undefined) {
        fail(`${path}.device solo vale con source "smartctl"`);
      }
    } else {
      config.device = expectString(object["device"], `${path}.device`);
      if (object["chip"] !== undefined || object["label"] !== undefined) {
        fail(`${path}.chip y ${path}.label solo valen con source "hwmon"`);
      }
    }
    return config;
  });
}

const DEFAULT_DISPLAY: DisplayConfig = {
  showGroups: true,
  showFail2banBreakdown: true,
  showPing: true,
  progressBarBlocks: 5,
  colors: { ok: "#00FF41", warning: "#FFAA00", critical: "#FF0040" },
};

function parseDisplay(value: unknown): DisplayConfig {
  if (value === undefined) return { ...DEFAULT_DISPLAY, colors: { ...DEFAULT_DISPLAY.colors } };
  const object = expectObject(value, "inventory.display");
  expectKnownKeys(
    object,
    ["show_groups", "show_fail2ban_breakdown", "show_ping", "progress_bar_blocks", "colors"],
    "inventory.display",
  );
  const colors = object["colors"] === undefined
    ? { ...DEFAULT_DISPLAY.colors }
    : parseColors(object["colors"]);
  const blocks = object["progress_bar_blocks"] === undefined
    ? DEFAULT_DISPLAY.progressBarBlocks
    : expectNumber(object["progress_bar_blocks"], "inventory.display.progress_bar_blocks", {
        min: 1,
        max: 10,
      });
  return {
    showGroups: object["show_groups"] === undefined
      ? DEFAULT_DISPLAY.showGroups
      : expectBoolean(object["show_groups"], "inventory.display.show_groups"),
    showFail2banBreakdown: object["show_fail2ban_breakdown"] === undefined
      ? DEFAULT_DISPLAY.showFail2banBreakdown
      : expectBoolean(
          object["show_fail2ban_breakdown"],
          "inventory.display.show_fail2ban_breakdown",
        ),
    showPing: object["show_ping"] === undefined
      ? DEFAULT_DISPLAY.showPing
      : expectBoolean(object["show_ping"], "inventory.display.show_ping"),
    progressBarBlocks: blocks,
    colors,
  };
}

function parseColors(value: unknown): DisplayColors {
  const object = expectObject(value, "inventory.display.colors");
  expectKnownKeys(object, ["ok", "warning", "critical"], "inventory.display.colors");
  const parsed = { ...DEFAULT_DISPLAY.colors };
  for (const key of ["ok", "warning", "critical"] as const) {
    if (object[key] !== undefined) {
      const color = expectString(object[key], `inventory.display.colors.${key}`);
      if (!/^#[0-9a-fA-F]{6}$/.test(color)) {
        fail(`inventory.display.colors.${key} debe ser un color hex #RRGGBB (recibido: ${JSON.stringify(color)})`);
      }
      parsed[key] = color;
    }
  }
  return parsed;
}

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

function parseAlerts(value: unknown): AlertsConfig {
  const thresholds: Record<MetricKey, MetricThreshold> = {
    cpu_percent: { ...DEFAULT_ALERT_THRESHOLDS.cpu_percent },
    memory_percent: { ...DEFAULT_ALERT_THRESHOLDS.memory_percent },
    disk_percent: { ...DEFAULT_ALERT_THRESHOLDS.disk_percent },
    ping_ms: { ...DEFAULT_ALERT_THRESHOLDS.ping_ms },
  };
  if (value === undefined) return { cooldownMinutes: 30, thresholds };

  const object = expectObject(value, "inventory.alerts");
  expectKnownKeys(object, ["cooldown_minutes", "thresholds"], "inventory.alerts");

  const cooldownMinutes = object["cooldown_minutes"] === undefined
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
    temperatures: object["temperatures"] === undefined ? [] : parseTemperatures(object["temperatures"]),
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

/** Lee el `.env` (si existe) sin mutar `process.env`. */
export function parseEnvFile(path: string): Record<string, string> {
  try {
    return dotenv.parse(readFileSync(path, "utf8"));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return {};
    fail(`no se puede leer ${path}: ${(error as Error).message}`);
  }
}

export function parseAppConfig(env: Record<string, string | undefined>): AppConfig {
  const statePath = optionalEnv(env, "STATE_PATH") ?? DEFAULT_STATE_PATH;
  const inventoryPath = optionalEnv(env, "INVENTORY_PATH") ?? DEFAULT_INVENTORY_PATH;

  return {
    discordToken: requiredEnv(env, "DISCORD_TOKEN"),
    botDisplayName: optionalEnv(env, "BOT_DISPLAY_NAME") ?? "server-status",
    hostLabel: optionalEnv(env, "HOST_LABEL"),
    activity: {
      type: parseActivityType(readEnv(env, "BOT_ACTIVITY_TYPE")),
      name: optionalEnv(env, "BOT_ACTIVITY_NAME") ?? "server status",
      state: optionalEnv(env, "BOT_ACTIVITY_STATE"),
      url: optionalEnv(env, "BOT_ACTIVITY_URL"),
    },
    statusChannelId: snowflakeEnv(env, "STATUS_CHANNEL_ID", true),
    alertChannelId: snowflakeEnv(env, "ALERT_CHANNEL_ID", false),
    guildId: snowflakeEnv(env, "GUILD_ID", false),
    requiredRoles: parseRequiredRoles(optionalEnv(env, "REQUIRED_ROLES") ?? undefined),
    updateIntervalSeconds: intEnv(
      env,
      "UPDATE_INTERVAL",
      DEFAULT_UPDATE_INTERVAL_SECONDS,
      { min: 10, max: 86_400 },
    ),
    httpTimeoutMs: intEnv(env, "HTTP_TIMEOUT_MS", DEFAULT_HTTP_TIMEOUT_MS, { min: 100 }),
    diskMount: optionalEnv(env, "DISK_MOUNT") ?? DEFAULT_DISK_MOUNT,
    statePath,
    inventoryPath,
    logFile: readEnv(env, "LOG_FILE") ?? DEFAULT_LOG_FILE,
    logLevel: readEnv(env, "LOG_LEVEL") ?? DEFAULT_LOG_LEVEL,
    sudoPath: optionalEnv(env, "SUDO_PATH") ?? DEFAULT_SUDO_PATH,
    fail2banClientPath: optionalEnv(env, "FAIL2BAN_CLIENT") ?? DEFAULT_FAIL2BAN_CLIENT_PATH,
  };
}

export interface LoadConfigOptions {
  /** Variables del proceso. Por defecto, `process.env`. */
  env?: Record<string, string | undefined>;
  /** Directorio base para resolver rutas relativas. Por defecto, el cwd. */
  cwd?: string;
  /** Ruta del `.env`. Por defecto, `<cwd>/.env`. */
  envFile?: string;
}

/**
 * Carga `.env` + `inventory.yaml` y devuelve la configuracion tipada.
 * Las variables del proceso tienen prioridad sobre el fichero `.env`.
 */
export function loadConfig(options: LoadConfigOptions = {}): LoadedConfig {
  const cwd = options.cwd ?? process.cwd();
  const envFile = options.envFile
    ? absolute(cwd, options.envFile)
    : absolute(cwd, ".env");
  const processEnv = options.env ?? process.env;

  const fileEnv = parseEnvFile(envFile);
  const merged: Record<string, string | undefined> = { ...fileEnv, ...processEnv };

  const app = parseAppConfig(merged);
  app.inventoryPath = absolute(cwd, app.inventoryPath);
  app.statePath = absolute(cwd, app.statePath);
  const inventory = loadInventory(app.inventoryPath);
  return { app, inventory };
}

function absolute(cwd: string, path: string): string {
  return isAbsolute(path) ? path : resolve(cwd, path);
}
