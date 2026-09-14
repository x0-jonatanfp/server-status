import { describe, expect, it } from "vitest";

import {
  createWebsiteProbePort,
  probeWebsites,
} from "../src/infrastructure/http/website-probe.ts";

const WEBSITES = [
  { url: "https://uno.example", label: "uno" },
  { url: "https://dos.example", label: "dos" },
  { url: "https://tres.example", label: "tres" },
];

/** Respuesta minima: el adaptador solo mira el estado y cancela el cuerpo. */
function jsonResponse(status: number): Response {
  return new Response(status === 204 ? null : "cuerpo", { status });
}

describe("probeWebsites", () => {
  it("marca como arriba un 200 y mide la latencia", async () => {
    const statuses = await probeWebsites([WEBSITES[0]!], async () => jsonResponse(200), 1000);

    expect(statuses).toHaveLength(1);
    expect(statuses[0]).toMatchObject({ label: "uno", up: true, statusCode: 200, error: null });
    expect(statuses[0]?.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("marca como caida un 5xx, sin lanzar", async () => {
    const statuses = await probeWebsites([WEBSITES[0]!], async () => jsonResponse(503), 1000);

    // Hubo respuesta, asi que se mide la latencia aunque el estado sea caida.
    expect(statuses[0]).toMatchObject({ up: false, statusCode: 503 });
    expect(statuses[0]?.latencyMs).toBeGreaterThanOrEqual(0);
    expect(statuses[0]?.error).toBeNull();
  });

  it("marca como caida un 404", async () => {
    const statuses = await probeWebsites([WEBSITES[0]!], async () => jsonResponse(404), 1000);
    expect(statuses[0]?.up).toBe(false);
  });

  it("reporta un timeout como caida, con el error, sin lanzar", async () => {
    const fetchFn: typeof fetch = async (_input, init) => {
      // Simula lo que hace AbortSignal.timeout al agotarse el plazo.
      return await new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(Object.assign(new Error("This operation was aborted"), { name: "TimeoutError" }));
        });
      });
    };

    const statuses = await probeWebsites([WEBSITES[0]!], fetchFn, 10);

    expect(statuses[0]).toMatchObject({
      up: false,
      statusCode: null,
      latencyMs: null,
      error: "timeout",
    });
  });

  it("reporta un fallo de red como caida y sigue con las demas webs", async () => {
    const fetchFn: typeof fetch = async (input) => {
      if (String(input).includes("dos")) throw new Error("getaddrinfo ENOTFOUND");
      return jsonResponse(200);
    };

    const statuses = await probeWebsites(WEBSITES, fetchFn, 1000);

    expect(statuses.map((status) => status.up)).toEqual([true, false, true]);
    expect(statuses[1]?.error).toBe("getaddrinfo ENOTFOUND");
  });

  it("pasa un timeout al fetch", async () => {
    const timeouts: number[] = [];
    const fetchFn: typeof fetch = async (_input, init) => {
      timeouts.push(init?.signal ? 1 : 0);
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return jsonResponse(200);
    };

    await probeWebsites([WEBSITES[0]!], fetchFn, 1234);

    expect(timeouts).toEqual([1]);
  });

  it("no lanza con una lista vacia", async () => {
    await expect(probeWebsites([], fetch, 1000)).resolves.toEqual([]);
  });
});

describe("createWebsiteProbePort", () => {
  it("implementa el puerto y usa su propio timeout", async () => {
    const port = createWebsiteProbePort({
      websites: WEBSITES,
      timeoutMs: 2000,
      fetchFn: async () => jsonResponse(200),
    });

    const statuses = await port.probe();
    expect(statuses.map((status) => status.up)).toEqual([true, true, true]);
  });
});
