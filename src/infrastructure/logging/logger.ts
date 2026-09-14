/**
 * Logger del servicio.
 *
 * Un solo fichero de log por servicio (`LOG_FILE`, por defecto `logs/bot.log`),
 * tal como el resto de servicios de la maquina. En desarrollo se escribe
 * tambien a consola.
 *
 * Winston cumple el puerto `LoggerPort` del dominio tal cual (info/warn/error/
 * debug), asi que no hace falta envolverlo.
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import winston from "winston";

/** Ruta por defecto del log cuando `LOG_FILE` no esta definida. */
export const DEFAULT_LOG_FILE = "logs/bot.log";

/**
 * Nivel por defecto. En los tests se silencia para no ensuciar la salida con
 * trazas de los adaptadores.
 */
export const DEFAULT_LOG_LEVEL = process.env["VITEST"] ? "silent" : "info";

export interface LoggerOptions {
  /** Fichero de log. `null` desactiva el transporte a fichero. */
  logFile?: string | null;
  level?: string;
  /** Fuerza el transporte a consola (por defecto, solo si no se escribe a fichero). */
  console?: boolean;
}

const lineFormat = winston.format.combine(
  winston.format.timestamp(),
  winston.format.errors({ stack: true }),
  winston.format.printf(({ timestamp, level, message, stack }) => {
    const detail = typeof stack === "string" ? `\n${stack}` : "";
    return `${String(timestamp)} ${level} ${String(message)}${detail}`;
  }),
);

export function createLogger(options: LoggerOptions = {}): winston.Logger {
  const logFile = options.logFile === undefined ? DEFAULT_LOG_FILE : options.logFile;
  const level = options.level ?? DEFAULT_LOG_LEVEL;
  const transports: winston.transport[] = [];

  if (logFile) {
    // winston no crea el directorio del fichero: sin esto, un LOG_FILE en un
    // directorio inexistente haria fallar el arranque del servicio.
    mkdirSync(dirname(logFile), { recursive: true });
    transports.push(new winston.transports.File({ filename: logFile, level }));
  }

  if (options.console ?? logFile === null) {
    transports.push(new winston.transports.Console({ level }));
  }

  return winston.createLogger({ level, format: lineFormat, transports });
}
