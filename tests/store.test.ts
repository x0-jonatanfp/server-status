import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it, vi } from "vitest";

import { JsonStateStore, parseState } from "../src/infrastructure/persistence/state-store.ts";

const tmpDirs: string[] = [];

function tmpStatePath(): string {
  const dir = mkdtempSync(join(tmpdir(), "server-status-state-"));
  tmpDirs.push(dir);
  return join(dir, "data", "state.json");
}

function logger() {
  return { warn: vi.fn(), debug: vi.fn() };
}

afterAll(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

describe("JsonStateStore", () => {
  it("empieza vacio si no hay estado previo", async () => {
    const store = new JsonStateStore({ path: tmpStatePath(), logger: logger() });

    expect(await store.snapshot()).toEqual({ version: 1, statusChannelId: null, channels: {} });
    expect(await store.getMessageId("123")).toBeNull();
  });

  it("persiste el mensaje del canal y sobrevive a un reinicio", async () => {
    const path = tmpStatePath();
    const first = new JsonStateStore({ path, logger: logger() });
    await first.setMessageId("111111111111111111", "1392999999999999999", new Date(1000));

    // Otra instancia, como si el servicio se hubiera reiniciado.
    const second = new JsonStateStore({ path, logger: logger() });
    expect(await second.getMessageId("111111111111111111")).toBe("1392999999999999999");
    expect(await second.getChannelState("111111111111111111")).toEqual({
      messageId: "1392999999999999999",
      updatedAt: new Date(1000).toISOString(),
    });
  });

  it("escribe de forma atomica y no deja temporales", async () => {
    const path = tmpStatePath();
    const store = new JsonStateStore({ path, logger: logger() });
    await store.setMessageId("1", "2", new Date(0));

    expect(readdirSync(join(path, ".."))).toEqual(["state.json"]);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      version: 1,
      statusChannelId: null,
      channels: { "1": { messageId: "2", updatedAt: new Date(0).toISOString() } },
    });
  });

  it("descarta un estado corrupto y lo avisa, sin romper", async () => {
    const path = tmpStatePath();
    const store = new JsonStateStore({ path, logger: logger() });
    await store.setMessageId("1", "2");
    writeFileSync(path, "{ esto no es json");

    const log = logger();
    const restarted = new JsonStateStore({ path, logger: log });
    expect(await restarted.snapshot()).toEqual({ version: 1, statusChannelId: null, channels: {} });
    expect(log.warn).toHaveBeenCalledOnce();
  });

  it("persiste el canal fijado con /set_channel y sigue leyendo estados antiguos", async () => {
    const path = tmpStatePath();
    const store = new JsonStateStore({ path, logger: logger() });
    await store.setStatusChannelId("111111111111111111");

    const restarted = new JsonStateStore({ path, logger: logger() });
    expect(await restarted.getStatusChannelId()).toBe("111111111111111111");

    // Un estado escrito antes de existir ese campo sigue valiendo.
    writeFileSync(path, JSON.stringify({ version: 1, channels: {} }));
    const withoutField = new JsonStateStore({ path, logger: logger() });
    expect(await withoutField.getStatusChannelId()).toBeNull();
  });

  it("permite olvidar el mensaje de un canal", async () => {
    const store = new JsonStateStore({ path: tmpStatePath(), logger: logger() });
    await store.setMessageId("1", "2");
    await store.setMessageId("1", null);
    expect(await store.getMessageId("1")).toBeNull();
  });
});

describe("parseState", () => {
  it("rechaza un estado de otra version", () => {
    expect(() => parseState(JSON.stringify({ version: 99, channels: {} }))).toThrowError(/version/);
  });

  it("normaliza entradas raras en lugar de romper", () => {
    const state = parseState(
      JSON.stringify({
        version: 1,
        channels: {
          "1": { messageId: 42, updatedAt: null },
          "2": null,
          "3": { messageId: "abc", updatedAt: "2026-09-14T14:32:10.000Z" },
        },
      }),
    );

    expect(state.channels["1"]).toEqual({ messageId: null, updatedAt: null });
    expect(state.channels["2"]).toBeUndefined();
    expect(state.channels["3"]).toEqual({
      messageId: "abc",
      updatedAt: "2026-09-14T14:32:10.000Z",
    });
  });
});
