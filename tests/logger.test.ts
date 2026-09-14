import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { createLogger } from "../src/logger.ts";

const tmpDirs: string[] = [];

afterAll(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

/** Espera a que el transporte a fichero haya volcado la linea. */
async function waitForContent(path: string, timeoutMs = 2000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return readFileSync(path, "utf8");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`el log ${path} no se ha escrito en ${timeoutMs} ms`);
}

describe("createLogger", () => {
  it("escribe en el fichero indicado y crea su directorio", async () => {
    const dir = mkdtempSync(join(tmpdir(), "server-status-log-"));
    tmpDirs.push(dir);
    const logFile = join(dir, "sub", "bot.log");

    const logger = createLogger({ logFile, level: "info" });
    logger.info("hola desde el test");
    // El transporte a fichero escribe de forma asincrona.
    const content = await waitForContent(logFile);
    logger.close();

    expect(content).toContain("hola desde el test");
  });

  it("no falla si se desactiva el fichero", () => {
    const logger = createLogger({ logFile: null, level: "info" });
    expect(() => logger.info("solo consola")).not.toThrow();
    logger.close();
  });
});
