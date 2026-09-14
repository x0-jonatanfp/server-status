import { describe, expect, it } from "vitest";

import type { ServiceGroup } from "../src/domain/entities/inventory.ts";
import type { ExecFileFn } from "../src/infrastructure/exec.ts";
import { createServiceStatusPort } from "../src/infrastructure/systemd/service-status.ts";

/** Salida real de `systemctl show -p Id,LoadState,ActiveState,SubState`. */
const SYSTEMCTL_OUTPUT = [
  "Id=nginx.service",
  "LoadState=loaded",
  "ActiveState=active",
  "SubState=running",
  "",
  "Id=fail2ban.service",
  "LoadState=loaded",
  "ActiveState=failed",
  "SubState=failed",
  "",
  "Id=redis-server.service",
  "LoadState=loaded",
  "ActiveState=inactive",
  "SubState=dead",
  "",
  "Id=no-such-unit-xyz.service",
  "LoadState=not-found",
  "ActiveState=inactive",
  "SubState=dead",
  "",
].join("\n");

const execReturning = (stdout: string): ExecFileFn => async () => ({ stdout, stderr: "" });

const GROUPS: ServiceGroup[] = [
  { group: "Infra", units: ["nginx", "fail2ban", "redis-server", "no-such-unit-xyz"] },
  { group: "Apps", units: ["nginx"] },
];

describe("createServiceStatusPort", () => {
  it("agrupa las unidades del inventario y traduce su estado", async () => {
    const groups = await createServiceStatusPort({
      groups: GROUPS,
      exec: execReturning(SYSTEMCTL_OUTPUT),
    }).collect();

    expect(groups.map((group) => group.group)).toEqual(["Infra", "Apps"]);
    expect(groups[0]?.units).toEqual([
      { unit: "nginx", state: "active" },
      { unit: "fail2ban", state: "failed" },
      { unit: "redis-server", state: "inactive" },
      { unit: "no-such-unit-xyz", state: "unknown" },
    ]);
    expect(groups[1]?.units).toEqual([{ unit: "nginx", state: "active" }]);
  });

  it("pregunta una sola vez por todas las unidades, sin duplicados", async () => {
    const calls: string[][] = [];
    const exec: ExecFileFn = async (file, args) => {
      calls.push([file, ...args]);
      return { stdout: SYSTEMCTL_OUTPUT, stderr: "" };
    };

    await createServiceStatusPort({
      groups: GROUPS,
      exec,
      systemctlPath: "/usr/bin/systemctl",
    }).collect();

    expect(calls).toHaveLength(1);
    expect(calls[0]?.slice(0, 3)).toEqual(["/usr/bin/systemctl", "show", "-p"]);
    expect(calls[0]?.at(-5)).toBe("--");
    expect(calls[0]?.slice(-4)).toEqual(["nginx", "fail2ban", "redis-server", "no-such-unit-xyz"]);
  });

  it("reporta unknown sin romper si systemctl falla", async () => {
    const exec: ExecFileFn = async () => {
      throw new Error("systemd no responde");
    };

    const groups = await createServiceStatusPort({ groups: GROUPS, exec }).collect();

    expect(groups[0]?.units.map((unit) => unit.state)).toEqual([
      "unknown",
      "unknown",
      "unknown",
      "unknown",
    ]);
  });

  it("reporta unknown si la unidad no sale en la respuesta", async () => {
    const groups = await createServiceStatusPort({
      groups: [{ group: "Infra", units: ["nginx", "otra"] }],
      exec: execReturning("Id=nginx.service\nLoadState=loaded\nActiveState=active\n"),
    }).collect();

    expect(groups[0]?.units).toEqual([
      { unit: "nginx", state: "active" },
      { unit: "otra", state: "unknown" },
    ]);
  });

  it("trata un LoadState roto como unknown", async () => {
    const groups = await createServiceStatusPort({
      groups: [{ group: "Infra", units: ["rota"] }],
      exec: execReturning("Id=rota.service\nLoadState=error\nActiveState=inactive\n"),
    }).collect();

    expect(groups[0]?.units[0]?.state).toBe("unknown");
  });

  it("no lanza con una lista de grupos vacia", async () => {
    await expect(
      createServiceStatusPort({ groups: [], exec: execReturning("") }).collect(),
    ).resolves.toEqual([]);
  });

  it.skipIf(process.platform !== "linux")("lee el estado real de systemd sin sudo", async () => {
    const groups = await createServiceStatusPort({
      groups: [{ group: "Infra", units: ["nginx", "no-such-unit-xyz"] }],
    }).collect();

    expect(groups[0]?.units).toEqual([
      { unit: "nginx", state: "active" },
      { unit: "no-such-unit-xyz", state: "unknown" },
    ]);
  });
});
