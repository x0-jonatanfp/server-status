/**
 * Comprobacion de las webs del inventario por HTTP.
 *
 * Se usa el `fetch` nativo con `AbortSignal.timeout`, asi que una web que no
 * responde se reporta como caida con la latencia a null, en vez de lanzar una
 * excepcion que tumbe el ciclo entero. Se consideran caidas las respuestas
 * 4xx/5xx y tambien los fallos de red o DNS.
 */
import type { WebsiteConfig } from "../config.ts";

const DEFAULT_TIMEOUT_MS = 8000;
const USER_AGENT = "server-status (monitor de disponibilidad)";

export interface WebsiteStatus {
  label: string;
  url: string;
  up: boolean;
  /** Codigo HTTP de la respuesta final, `null` si ni siquiera hubo respuesta. */
  statusCode: number | null;
  /** Milisegundos hasta la primera respuesta, `null` si fallo. */
  latencyMs: number | null;
  error: string | null;
}

export interface CollectWebsitesOptions {
  websites: WebsiteConfig[];
  timeoutMs?: number;
  /** Inyectable en los tests. */
  fetchFn?: typeof fetch;
}

export async function collectWebsites(
  options: CollectWebsitesOptions,
): Promise<WebsiteStatus[]> {
  const fetchFn = options.fetchFn ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return Promise.all(
    options.websites.map(async (website): Promise<WebsiteStatus> => {
      const started = performance.now();
      try {
        const response = await fetchFn(website.url, {
          method: "GET",
          redirect: "follow",
          headers: { "user-agent": USER_AGENT },
          signal: AbortSignal.timeout(timeoutMs),
        });
        const latencyMs = performance.now() - started;
        // Se descarta el cuerpo: solo interesan el estado y el tiempo.
        await response.body?.cancel();

        return {
          label: website.label,
          url: website.url,
          up: response.status >= 200 && response.status < 400,
          statusCode: response.status,
          latencyMs: Math.round(latencyMs),
          error: null,
        };
      } catch (error) {
        return {
          label: website.label,
          url: website.url,
          up: false,
          statusCode: null,
          latencyMs: null,
          error: describeError(error),
        };
      }
    }),
  );
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.name === "TimeoutError" ? "timeout" : error.message;
  }
  return String(error);
}
