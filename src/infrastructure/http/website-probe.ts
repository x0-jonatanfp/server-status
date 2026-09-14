/**
 * Comprobacion de las webs del inventario por HTTP.
 *
 * Se usa el `fetch` nativo con `AbortSignal.timeout`, asi que una web que no
 * responde se reporta como caida con la latencia a null, en vez de lanzar una
 * excepcion que tumbe el ciclo entero. Se consideran caidas las respuestas
 * 4xx/5xx y tambien los fallos de red o DNS.
 */
import type { WebsiteTarget } from "../../domain/entities/inventory.ts";
import type { WebsiteStatus } from "../../domain/entities/website-status.ts";
import type { WebsiteProbePort } from "../../domain/ports/websites.ts";

const DEFAULT_TIMEOUT_MS = 8000;
const USER_AGENT = "server-status (monitor de disponibilidad)";

export interface WebsiteProbePortOptions {
  websites: WebsiteTarget[];
  timeoutMs?: number;
  /** Inyectable en los tests. */
  fetchFn?: typeof fetch;
}

export function createWebsiteProbePort(options: WebsiteProbePortOptions): WebsiteProbePort {
  const fetchFn = options.fetchFn ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    probe: () => probeWebsites(options.websites, fetchFn, timeoutMs),
  };
}

export async function probeWebsites(
  websites: WebsiteTarget[],
  fetchFn: typeof fetch,
  timeoutMs: number,
): Promise<WebsiteStatus[]> {
  return Promise.all(
    websites.map(async (website): Promise<WebsiteStatus> => {
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
