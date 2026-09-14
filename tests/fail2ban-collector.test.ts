import { describe, expect, it } from "vitest";

import type { ExecFileFn } from "../src/collectors/exec.ts";
import {
  collectFail2ban,
  InvalidIpError,
  parseCurrentlyBanned,
  parseJailList,
  unbanIp,
} from "../src/collectors/fail2ban.ts";

const JAILS = [
  "dovecot",
  "nginx-botsearch",
  "nginx-http-auth",
  "nginx-req-limit",
  "postfix",
  "postfix-sasl-extra",
  "postgresql",
  "recidive",
  "sshd",
];

const OVERVIEW = [
  "Status",
  "|- Number of jail:\t9",
  `\`- Jail list:\t${JAILS.join(", ")}`,
  "",
].join("\n");

const BANNED: Record<string, number> = {
  dovecot: 0,
  "nginx-botsearch": 1,
  "nginx-http-auth": 0,
  "nginx-req-limit": 0,
  postfix: 2,
  "postfix-sasl-extra": 3,
  postgresql: 0,
  recidive: 31,
  sshd: 6,
};

function jailOutput(name: string, banned: number): string {
  return [
    `Status for the jail: ${name}`,
    "|- Filter",
    "|  |- Currently failed:\t0",
    "|  `- File list:\t/var/log/auth.log",
    "`- Actions",
    `   |- Currently banned:\t${banned}`,
    `   |- Total banned:\t${banned}`,
    "   `- Banned IP list:\t",
  ].join("\n");
}

/** Exec de mentira que responde a `status`, `status <carcel>` y `set`. */
function fakeExec(
  overrides: { overview?: string; failJail?: string } = {},
): { exec: ExecFileFn; calls: string[][] } {
  const calls: string[][] = [];

  const exec: ExecFileFn = async (_file, args) => {
    calls.push(args);
    const command = args[2];
    if (command === "status") {
      const jail = args[3];
      if (jail === undefined) {
        return { stdout: overrides.overview ?? OVERVIEW };
      }
      if (jail === overrides.failJail) throw new Error(`carcel desconocida: ${jail}`);
      return { stdout: jailOutput(jail, BANNED[jail] ?? 0) };
    }
    if (command === "set") return { stdout: args[5] ?? "" };
    throw new Error(`comando no esperado: ${args.join(" ")}`);
  };

  return { exec, calls };
}

describe("collectFail2ban", () => {
  it("parsea las 9 carceles y suma los baneos", async () => {
    const status = await collectFail2ban({ exec: fakeExec().exec });

    expect(status.available).toBe(true);
    expect(status.error).toBeNull();
    expect(status.jails.map((jail) => jail.name)).toEqual(JAILS);
    expect(status.jails.find((jail) => jail.name === "recidive")?.banned).toBe(31);
    expect(status.totalBanned).toBe(43);
  });

  it("consulta cada carcel con sudo -n, sin shell", async () => {
    const { exec, calls } = fakeExec();
    await collectFail2ban({
      exec,
      sudoPath: "/usr/bin/sudo",
      clientPath: "/usr/bin/fail2ban-client",
    });

    expect(calls[0]).toEqual(["-n", "/usr/bin/fail2ban-client", "status"]);
    expect(calls[1]).toEqual(["-n", "/usr/bin/fail2ban-client", "status", "dovecot"]);
    expect(calls).toHaveLength(10);
  });

  it("una carcel que falla queda a null y no rompe el resto", async () => {
    const status = await collectFail2ban({ exec: fakeExec({ failJail: "sshd" }).exec });

    expect(status.available).toBe(true);
    expect(status.jails.find((jail) => jail.name === "sshd")?.banned).toBeNull();
    // 43 menos los 6 de sshd.
    expect(status.totalBanned).toBe(37);
  });

  it("reporta available=false sin lanzar si el cliente falla", async () => {
    const exec: ExecFileFn = async () => {
      throw new Error("sudo: no tty present");
    };

    const status = await collectFail2ban({ exec });

    expect(status).toMatchObject({ available: false, totalBanned: 0, jails: [] });
    expect(status.error).toContain("no tty present");
  });

  it("no lanza si no hay carceles configuradas", async () => {
    const status = await collectFail2ban({
      exec: fakeExec({ overview: "Status\n|- Number of jail:\t0\n" }).exec,
    });
    expect(status).toMatchObject({ available: true, totalBanned: 0, jails: [] });
  });
});

describe("unbanIp", () => {
  it("no ejecuta nada si la IP no es valida", async () => {
    const calls: string[][] = [];
    const exec: ExecFileFn = async (_file, args) => {
      calls.push(args);
      return { stdout: OVERVIEW };
    };

    const invalidas = ["", "no-es-una-ip", "1.2.3.4; rm -rf /", "999.999.999.999", "$(whoami)"];
    for (const ip of invalidas) {
      await expect(unbanIp(ip, { exec })).rejects.toBeInstanceOf(InvalidIpError);
    }
    expect(calls).toEqual([]);
  });

  it("desbanea la IP en todas las carceles", async () => {
    const { exec, calls } = fakeExec();
    const result = await unbanIp("203.0.113.7", {
      exec,
      sudoPath: "/usr/bin/sudo",
      clientPath: "/usr/bin/fail2ban-client",
    });

    expect(result.ip).toBe("203.0.113.7");
    expect(result.jails.every((jail) => jail.ok)).toBe(true);
    expect(result.jails).toHaveLength(9);
    expect(calls[1]).toEqual([
      "-n",
      "/usr/bin/fail2ban-client",
      "set",
      "dovecot",
      "unbanip",
      "203.0.113.7",
    ]);
  });

  it("acepta una IPv6", async () => {
    const { exec } = fakeExec();
    const result = await unbanIp("2001:db8::1", { exec });
    expect(result.jails.every((jail) => jail.ok)).toBe(true);
  });

  it("informa del fallo por carcel sin lanzar", async () => {
    const exec: ExecFileFn = async (_file, args) => {
      if (args[2] === "status" && args[3] === undefined) return { stdout: OVERVIEW };
      if (args[2] === "status") return { stdout: jailOutput(String(args[3]), 1) };
      if (args[3] === "sshd") throw new Error("no se pudo desbanear");
      return { stdout: "" };
    };

    const result = await unbanIp("203.0.113.7", { exec });

    expect(result.jails.find((jail) => jail.name === "sshd")).toMatchObject({
      ok: false,
      error: "no se pudo desbanear",
    });
    expect(result.jails.filter((jail) => jail.ok)).toHaveLength(8);
  });
});

describe("parsers", () => {
  it("parseJailList lee la lista y tolera la ausencia", () => {
    expect(parseJailList(OVERVIEW)).toEqual(JAILS);
    expect(parseJailList("Status\n")).toEqual([]);
    expect(parseJailList("`- Jail list:\t")).toEqual([]);
  });

  it("parseCurrentlyBanned lee el contador", () => {
    expect(parseCurrentlyBanned(jailOutput("sshd", 6))).toBe(6);
    expect(parseCurrentlyBanned("nanay")).toBeNull();
  });
});

describe.runIf(process.platform === "linux")("fail2ban en esta maquina", () => {
  it("ve las 9 carceles, incluidas las que el bot antiguo no conocia", async () => {
    const status = await collectFail2ban();

    expect(status.available).toBe(true);
    expect(status.jails).toHaveLength(9);
    expect(status.jails.map((jail) => jail.name)).toContain("postgresql");
    expect(status.jails.map((jail) => jail.name)).toContain("postfix-sasl-extra");
    for (const jail of status.jails) {
      expect(jail.banned === null || jail.banned >= 0).toBe(true);
    }
  });
});
