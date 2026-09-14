/**
 * Estado de fail2ban y desbaneo de IPs.
 *
 * Las consultas van por `sudo -n /usr/bin/fail2ban-client` (la regla NOPASSWD
 * ya existe) y siempre con `execFile` y argumentos en lista, nunca con shell:
 * la IP de `/unban` la escribe una persona en Discord y no puede acabar
 * interpretada por un shell. Ademas se valida antes de invocar nada.
 *
 * El bot antiguo solo conocia 7 de las 9 carceles, asi que `/unban` dejaba
 * baneos sin limpiar; aqui las carceles salen siempre de la respuesta de
 * fail2ban, nunca de una lista fija.
 */
import { isIP } from "node:net";

import { defaultExec, stdoutOf, type ExecFileFn } from "./exec.ts";

const DEFAULT_SUDO_PATH = "/usr/bin/sudo";
const DEFAULT_FAIL2BAN_CLIENT_PATH = "/usr/bin/fail2ban-client";
const DEFAULT_TIMEOUT_MS = 5000;

/** Error de validacion: la IP no se ha llegado a pasar a fail2ban. */
export class InvalidIpError extends Error {
  constructor(ip: string) {
    super(`${JSON.stringify(ip)} no es una IP valida`);
    this.name = "InvalidIpError";
  }
}

export interface Fail2banJailStatus {
  name: string;
  /** `null` si no se pudo consultar esa carcel. */
  banned: number | null;
}

export interface Fail2banStatus {
  /** `false` si el cliente no responde (servicio caido o sin permisos). */
  available: boolean;
  totalBanned: number;
  jails: Fail2banJailStatus[];
  error: string | null;
}

export interface Fail2banOptions {
  sudoPath?: string;
  clientPath?: string;
  timeoutMs?: number;
  exec?: ExecFileFn;
}

interface Fail2banClient {
  exec: ExecFileFn;
  sudoPath: string;
  clientPath: string;
  timeoutMs: number;
}

function client(options: Fail2banOptions): Fail2banClient {
  return {
    exec: options.exec ?? defaultExec,
    sudoPath: options.sudoPath ?? DEFAULT_SUDO_PATH,
    clientPath: options.clientPath ?? DEFAULT_FAIL2BAN_CLIENT_PATH,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  };
}

async function runClient(
  client_: Fail2banClient,
  args: string[],
): Promise<string> {
  const { stdout } = await client_.exec(
    client_.sudoPath,
    ["-n", client_.clientPath, ...args],
    { timeout: client_.timeoutMs },
  );
  return stdout;
}

/** Consulta el estado de todas las carceles. */
export async function collectFail2ban(
  options: Fail2banOptions = {},
): Promise<Fail2banStatus> {
  const fail2ban = client(options);

  let overview: string;
  try {
    overview = await runClient(fail2ban, ["status"]);
  } catch (error) {
    return {
      available: false,
      totalBanned: 0,
      jails: [],
      error: describeError(error, stdoutOf(error)),
    };
  }

  const names = parseJailList(overview);
  const jails = await Promise.all(
    names.map(async (name): Promise<Fail2banJailStatus> => {
      try {
        const output = await runClient(fail2ban, ["status", name]);
        return { name, banned: parseCurrentlyBanned(output) };
      } catch {
        return { name, banned: null };
      }
    }),
  );

  const totalBanned = jails.reduce((total, jail) => total + (jail.banned ?? 0), 0);
  return { available: true, totalBanned, jails, error: null };
}

/**
 * Desbanea una IP de todas las carceles. Lanza `InvalidIpError` sin ejecutar
 * nada si la IP no es valida.
 */
export async function unbanIp(
  ip: string,
  options: Fail2banOptions = {},
): Promise<Fail2banUnbanResult> {
  const trimmed = ip.trim();
  if (isIP(trimmed) === 0) throw new InvalidIpError(ip);

  const fail2ban = client(options);
  const names = await listJails(fail2ban);

  const jails = await Promise.all(
    names.map(async (name): Promise<Fail2banUnbanJail> => {
      try {
        await runClient(fail2ban, ["set", name, "unbanip", trimmed]);
        return { name, ok: true, error: null };
      } catch (error) {
        return { name, ok: false, error: describeError(error, stdoutOf(error)) };
      }
    }),
  );

  return { ip: trimmed, jails };
}

/** Carcles conocidas en el momento del desbaneo. */
export async function listJails(options: Fail2banOptions = {}): Promise<string[]> {
  const fail2ban = client(options);
  return parseJailList(await runClient(fail2ban, ["status"]));
}

export interface Fail2banUnbanJail {
  name: string;
  ok: boolean;
  error: string | null;
}

export interface Fail2banUnbanResult {
  ip: string;
  jails: Fail2banUnbanJail[];
}

/** Saca la lista de carceles de la salida de `fail2ban-client status`. */
export function parseJailList(output: string): string[] {
  const match = /Jail list:\s*(.*)$/m.exec(output);
  if (!match?.[1]) return [];
  return match[1]
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name !== "");
}

/** Saca `Currently banned` de la salida de `fail2ban-client status <carcel>`. */
export function parseCurrentlyBanned(output: string): number | null {
  const match = /Currently banned:\s*(\d+)/.exec(output);
  return match?.[1] === undefined ? null : Number(match[1]);
}

function describeError(error: unknown, stdout: string): string {
  const parts = [error instanceof Error ? error.message : String(error)];
  const detail = stdout.trim();
  if (detail !== "") parts.push(detail.split("\n").at(-1) ?? "");
  return parts.filter((part) => part !== "").join(": ");
}
