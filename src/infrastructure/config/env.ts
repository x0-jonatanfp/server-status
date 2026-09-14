/**
 * Configuracion del `.env`: secretos y valores simples.
 *
 * Regla del proyecto: ningun canal, rol, intervalo, ruta ni binario hardcodeado
 * en el codigo. Todo se valida al arrancar: si una variable falta o no parsea,
 * el proceso aborta diciendo cual, y las variables que se declaran funcionan de
 * verdad (el bug del bot antiguo era que `BOT_UPDATE_INTERVAL` no cambiaba
 * nada).
 *
 * El inventario (listas con estructura) vive aparte, en el adaptador
 * `inventory.ts`.
 */
import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

import dotenv from "dotenv";

import { DEFAULT_LOG_FILE, DEFAULT_LOG_LEVEL } from "../logging/logger.ts";
import { fail } from "./validation.ts";

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

const DEFAULT_INVENTORY_PATH = "inventory.yaml";
const DEFAULT_STATE_PATH = "data/state.json";
const DEFAULT_UPDATE_INTERVAL_SECONDS = 300;
const DEFAULT_HTTP_TIMEOUT_MS = 8000;
const DEFAULT_DISK_MOUNT = "/";
const DEFAULT_SUDO_PATH = "/usr/bin/sudo";
const DEFAULT_FAIL2BAN_CLIENT_PATH = "/usr/bin/fail2ban-client";

function readEnv(env: Record<string, string | undefined>, key: string): string | undefined {
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
  const value = Number(raw);
  if (bounds.min !== undefined && value < bounds.min) {
    fail(`${key} debe ser >= ${bounds.min} (recibido: ${value})`);
  }
  if (bounds.max !== undefined && value > bounds.max) {
    fail(`${key} debe ser <= ${bounds.max} (recibido: ${value})`);
  }
  return value;
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
  const parts = bracketed ? bracketed.map((chunk) => chunk.slice(1, -1)) : raw.split(",");
  return parts.map((part) => part.trim()).filter((part) => part !== "");
}

function parseActivityType(raw: string | undefined): ActivityTypeName {
  if (raw === undefined) return "Custom";
  const found = ACTIVITY_TYPE_NAMES.find((name) => name.toLowerCase() === raw.toLowerCase());
  return found ?? fail(`BOT_ACTIVITY_TYPE debe ser uno de: ${ACTIVITY_TYPE_NAMES.join(", ")}`);
}

/** Valida el entorno ya fusionado (fichero + proceso). */
export function parseAppConfig(env: Record<string, string | undefined>): AppConfig {
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
    updateIntervalSeconds: intEnv(env, "UPDATE_INTERVAL", DEFAULT_UPDATE_INTERVAL_SECONDS, {
      min: 10,
      max: 86_400,
    }),
    httpTimeoutMs: intEnv(env, "HTTP_TIMEOUT_MS", DEFAULT_HTTP_TIMEOUT_MS, { min: 100 }),
    diskMount: optionalEnv(env, "DISK_MOUNT") ?? DEFAULT_DISK_MOUNT,
    statePath: optionalEnv(env, "STATE_PATH") ?? DEFAULT_STATE_PATH,
    inventoryPath: optionalEnv(env, "INVENTORY_PATH") ?? DEFAULT_INVENTORY_PATH,
    logFile: readEnv(env, "LOG_FILE") ?? DEFAULT_LOG_FILE,
    logLevel: readEnv(env, "LOG_LEVEL") ?? DEFAULT_LOG_LEVEL,
    sudoPath: optionalEnv(env, "SUDO_PATH") ?? DEFAULT_SUDO_PATH,
    fail2banClientPath: optionalEnv(env, "FAIL2BAN_CLIENT") ?? DEFAULT_FAIL2BAN_CLIENT_PATH,
  };
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

export interface LoadAppConfigOptions {
  /** Variables del proceso. Por defecto, `process.env`. */
  env?: Record<string, string | undefined>;
  /** Directorio base para resolver rutas relativas. Por defecto, el cwd. */
  cwd?: string;
  /** Ruta del `.env`. Por defecto, `<cwd>/.env`. */
  envFile?: string;
}

/**
 * Carga el `.env` y valida el entorno. Las variables del proceso tienen
 * prioridad sobre el fichero. Las rutas relativas se devuelven absolutas.
 */
export function loadAppConfig(options: LoadAppConfigOptions = {}): AppConfig {
  const cwd = options.cwd ?? process.cwd();
  const envFile = absolute(cwd, options.envFile ?? ".env");
  const processEnv = options.env ?? process.env;

  const merged: Record<string, string | undefined> = { ...parseEnvFile(envFile), ...processEnv };
  const app = parseAppConfig(merged);
  app.inventoryPath = absolute(cwd, app.inventoryPath);
  app.statePath = absolute(cwd, app.statePath);
  return app;
}

function absolute(cwd: string, path: string): string {
  return isAbsolute(path) ? path : resolve(cwd, path);
}
