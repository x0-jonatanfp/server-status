import { describe, expect, it } from "vitest";

import { main } from "../src/main.ts";

describe("punto de entrada", () => {
  it("exporta main sin arrancar el bot al importarlo", () => {
    expect(typeof main).toBe("function");
    // Importar el modulo no puede registrar senales ni abrir el gateway: si lo
    // hiciera, cualquier test que importe main.ts arrancaria el bot entero.
    expect(process.listenerCount("SIGINT")).toBe(0);
    expect(process.listenerCount("SIGTERM")).toBe(0);
  });
});
