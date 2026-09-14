import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { AlertManager, type Alert } from "../src/alerts/alertManager.ts";
import type { StatusSnapshot } from "../src/collectors/index.ts";
import type { StatusView } from "../src/render/statusView.ts";
import { Scheduler, type PublishResult, type StatusPublisher } from "../src/scheduler.ts";
import { StateStore } from "../src/store.ts";

const CHANNEL = "111111111111111111";

const tmpDirs: string[] = [];

function tmpStatePath(): string {
  const dir = mkdtempSync(join(tmpdir(), "server-status-scheduler-"));
  tmpDirs.push(dir);
  return join(dir, "data", "state.json");
}

afterAll(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

afterEach(() => {
  vi.useRealTimers();
});

function snapshot(): StatusSnapshot {
  return {
    collectedAt: new Date(2026, 8, 14, 14, 32, 10),
    system: {
      cpuPercent: 12.4,
      memory: null,
      disk: null,
      uptimeSeconds: 3600,
      os: null,
    },
    temperatures: [],
    services: [],
    websites: [],
    fail2ban: { available: true, totalBanned: 0, jails: [], error: null },
    bot: { pingMs: 42, uptimeSeconds: 3600 },
  };
}

function view(): StatusView {
  return { blocks: ["🟢 SERVER STATUS"], level: "ok", accentColor: 0x00ff41 };
}

function logger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

/**
 * Publisher de mentira que imita a Discord: guarda los mensajes publicados y,
 * como Discord, falla al editar uno que ya no existe.
 */
class FakePublisher implements StatusPublisher {
  readonly messages = new Map<string, StatusView>();
  readonly calls: Array<{ existing: string | null; published: string }> = [];
  private counter = 0;

  async publish(
    _channelId: string,
    view_: StatusView,
    existingMessageId: string | null,
  ): Promise<PublishResult> {
    if (existingMessageId && this.messages.has(existingMessageId)) {
      this.messages.set(existingMessageId, view_);
      this.calls.push({ existing: existingMessageId, published: existingMessageId });
      return { messageId: existingMessageId, created: false };
    }
    const messageId = `mensaje-${++this.counter}`;
    this.messages.set(messageId, view_);
    this.calls.push({ existing: existingMessageId, published: messageId });
    return { messageId, created: true };
  }
}

function build(options: {
  storePath: string;
  publisher: FakePublisher;
  collect?: () => Promise<StatusSnapshot>;
  updateIntervalSeconds?: number;
  alerts?: AlertManager;
  notifyAlerts?: (alerts: Alert[]) => Promise<void>;
}): { scheduler: Scheduler; store: StateStore } {
  const store = new StateStore({ path: options.storePath, logger: logger() });
  const scheduler = new Scheduler({
    updateIntervalSeconds: options.updateIntervalSeconds ?? 300,
    channelId: CHANNEL,
    collect: options.collect ?? (async () => snapshot()),
    render: () => view(),
    publisher: options.publisher,
    store,
    logger: logger(),
    ...(options.alerts ? { alerts: options.alerts } : {}),
    ...(options.notifyAlerts ? { notifyAlerts: options.notifyAlerts } : {}),
  });
  return { scheduler, store };
}

describe("Scheduler", () => {
  it("dos ciclos producen un solo mensaje, editado", async () => {
    const publisher = new FakePublisher();
    const { scheduler } = build({ storePath: tmpStatePath(), publisher });

    const first = await scheduler.runOnce("startup");
    const second = await scheduler.runOnce("interval");

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(publisher.messages.size).toBe(1);
    expect(second.messageId).toBe(first.messageId);
    expect(publisher.calls).toEqual([
      { existing: null, published: "mensaje-1" },
      { existing: "mensaje-1", published: "mensaje-1" },
    ]);
  });

  it("sobrevive a un reinicio sin reenviar el mensaje", async () => {
    const storePath = tmpStatePath();
    const publisher = new FakePublisher();

    const before = build({ storePath, publisher });
    const run = await before.scheduler.runOnce("startup");

    // Reinicio: otro scheduler y otro store, el mismo fichero de estado.
    const after = build({ storePath, publisher });
    const restarted = await after.scheduler.runOnce("startup");

    expect(restarted.messageId).toBe(run.messageId);
    expect(restarted.created).toBe(false);
    expect(publisher.messages.size).toBe(1);
  });

  it("reenvia el mensaje y actualiza el id si ya no existe", async () => {
    const storePath = tmpStatePath();
    const publisher = new FakePublisher();
    const { scheduler, store } = build({ storePath, publisher });

    // Estado de un mensaje que se ha borrado a mano en Discord.
    await store.setMessageId(CHANNEL, "mensaje-borrado");
    const result = await scheduler.runOnce("interval");

    expect(result.created).toBe(true);
    expect(result.messageId).toBe("mensaje-1");
    expect(await store.getMessageId(CHANNEL)).toBe("mensaje-1");
  });

  it("un fallo de recoleccion no para el bucle", async () => {
    const publisher = new FakePublisher();
    let calls = 0;
    const { scheduler } = build({
      storePath: tmpStatePath(),
      publisher,
      collect: async () => {
        calls += 1;
        if (calls === 1) throw new Error("systeminformation explotó");
        return snapshot();
      },
    });

    const failed = await scheduler.runOnce("startup");
    expect(failed.error).toContain("systeminformation");
    expect(failed.messageId).toBeNull();

    const ok = await scheduler.runOnce("interval");
    expect(ok.error).toBeNull();
    expect(ok.created).toBe(true);
    expect(publisher.messages.size).toBe(1);
  });

  it("no solapa dos ciclos", async () => {
    const publisher = new FakePublisher();
    let collectCalls = 0;
    const { scheduler } = build({
      storePath: tmpStatePath(),
      publisher,
      collect: async () => {
        collectCalls += 1;
        await new Promise((resolve) => setTimeout(resolve, 10));
        return snapshot();
      },
    });

    const [a, b] = await Promise.all([scheduler.runOnce("manual"), scheduler.runOnce("interval")]);

    expect(collectCalls).toBe(1);
    expect(a).toBe(b);
    expect(publisher.calls).toHaveLength(1);
  });

  it("usa el intervalo de la configuracion y para al pararlo", async () => {
    const publisher = new FakePublisher();
    let collectCalls = 0;
    const { scheduler } = build({
      storePath: tmpStatePath(),
      publisher,
      // 0,02 s: el intervalo es el de la configuracion, no una constante.
      updateIntervalSeconds: 0.02,
      collect: async () => {
        collectCalls += 1;
        return snapshot();
      },
    });

    scheduler.start();
    // El arranque dispara un ciclo inmediato.
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(collectCalls).toBeGreaterThanOrEqual(1);

    await new Promise((resolve) => setTimeout(resolve, 200));
    const afterInterval = collectCalls;
    expect(afterInterval).toBeGreaterThanOrEqual(3);
    // Se edita el mismo mensaje en cada ciclo.
    expect(publisher.messages.size).toBe(1);

    await scheduler.stop();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(collectCalls).toBe(afterInterval);
  });

  it("envia las alertas y respeta el cooldown entre ciclos", async () => {
    let now = 1_000_000;
    const sent: Alert[][] = [];
    const alerts = new AlertManager({
      cooldownMinutes: 30,
      thresholds: {
        cpu_percent: { warn: 70, crit: 90 },
        memory_percent: { warn: 70, crit: 90 },
        disk_percent: { warn: 80, crit: 95 },
        ping_ms: { warn: 100, crit: 500 },
      },
      now: () => now,
    });

    const hot = snapshot();
    hot.temperatures = [
      { source: "hwmon", name: "CPU", celsius: 95, warn: 75, crit: 90, detail: "k10temp Tctl" },
    ];

    const { scheduler } = build({
      storePath: tmpStatePath(),
      publisher: new FakePublisher(),
      collect: async () => hot,
      alerts,
      notifyAlerts: async (pending) => {
        sent.push(pending);
      },
    });

    await scheduler.runOnce("startup");
    expect(sent).toHaveLength(1);
    expect(sent[0]?.[0]?.key).toBe("temperature:CPU");

    // Siguiente ciclo dentro del cooldown: no se repite.
    now += 5 * 60_000;
    await scheduler.runOnce("interval");
    expect(sent).toHaveLength(1);

    // Pasado el cooldown vuelve a avisar.
    now += 30 * 60_000;
    await scheduler.runOnce("interval");
    expect(sent).toHaveLength(2);
  });

  it("un fallo al enviar alertas no cambia el resultado del ciclo", async () => {
    const alerts = new AlertManager({
      cooldownMinutes: 30,
      thresholds: {
        cpu_percent: { warn: 1, crit: 2 },
        memory_percent: { warn: 1, crit: 2 },
        disk_percent: { warn: 1, crit: 2 },
        ping_ms: { warn: 1, crit: 2 },
      },
    });

    const { scheduler } = build({
      storePath: tmpStatePath(),
      publisher: new FakePublisher(),
      alerts,
      notifyAlerts: async () => {
        throw new Error("Discord no acepta el mensaje");
      },
    });

    const result = await scheduler.runOnce("startup");
    expect(result.error).toBeNull();
    expect(result.created).toBe(true);
  });

  it("guarda el resultado del ultimo ciclo", async () => {
    const publisher = new FakePublisher();
    const { scheduler } = build({ storePath: tmpStatePath(), publisher });

    expect(scheduler.lastRun).toBeNull();
    const result = await scheduler.runOnce("manual");
    expect(scheduler.lastRun).toBe(result);
    expect(result.reason).toBe("manual");
    expect(result.level).toBe("ok");
    expect(typeof result.durationMs).toBe("number");
  });
});
