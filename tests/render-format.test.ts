import { describe, expect, it } from "vitest";

import { VERSION } from "../src/version.ts";
import {
  formatBytes,
  formatCelsius,
  formatClock,
  formatInterval,
  formatMilliseconds,
  formatPercent,
  formatUptime,
  NOT_AVAILABLE,
  progressBar,
} from "../src/render/format.ts";

describe("formatBytes", () => {
  it("usa la unidad mas legible", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1024)).toBe("1 KB");
    expect(formatBytes(164.5 * 1024 ** 3)).toBe("164.5 GB");
    expect(formatBytes(2 * 1024 ** 4)).toBe("2.0 TB");
  });

  it("devuelve N/A si no hay dato", () => {
    expect(formatBytes(null)).toBe(NOT_AVAILABLE);
    expect(formatBytes(-1)).toBe(NOT_AVAILABLE);
    expect(formatBytes(Number.NaN)).toBe(NOT_AVAILABLE);
  });
});

describe("formatUptime", () => {
  it("compone dias, horas y minutos", () => {
    expect(formatUptime(4 * 86_400 + 12 * 3600 + 7 * 60)).toBe("4d 12h 07m");
    expect(formatUptime(3600 + 60)).toBe("01h 01m");
    expect(formatUptime(0)).toBe("00h 00m");
  });

  it("devuelve N/A si no hay dato", () => {
    expect(formatUptime(null)).toBe(NOT_AVAILABLE);
    expect(formatUptime(-5)).toBe(NOT_AVAILABLE);
  });
});

describe("formatPercent, formatCelsius y formatMilliseconds", () => {
  it("redondean a un decimal", () => {
    expect(formatPercent(18.44)).toBe("18.4%");
    expect(formatPercent(18.46)).toBe("18.5%");
    expect(formatCelsius(40.85)).toBe("40.9 °C");
    expect(formatMilliseconds(118.4)).toBe("118 ms");
  });

  it("devuelven N/A si no hay dato", () => {
    expect(formatPercent(null)).toBe(NOT_AVAILABLE);
    expect(formatCelsius(null)).toBe(NOT_AVAILABLE);
    expect(formatMilliseconds(null)).toBe(NOT_AVAILABLE);
  });
});

describe("progressBar", () => {
  it("pinta tantos bloques como porcentaje", () => {
    expect(progressBar(0, 5)).toBe("⬜⬜⬜⬜⬜");
    expect(progressBar(100, 5)).toBe("🟩🟩🟩🟩🟩");
    expect(progressBar(12.4, 5)).toBe("🟩⬜⬜⬜⬜");
    expect(progressBar(36, 10)).toBe("🟩🟩🟩🟩⬜⬜⬜⬜⬜⬜");
  });

  it("no se sale del numero de bloques ni con datos raros", () => {
    expect(progressBar(200, 5)).toBe("🟩🟩🟩🟩🟩");
    expect(progressBar(-10, 5)).toBe("⬜⬜⬜⬜⬜");
    expect(progressBar(null, 5)).toBe("⬜⬜⬜⬜⬜");
  });
});

describe("formatClock y formatInterval", () => {
  it("da la hora con dos digitos", () => {
    expect(formatClock(new Date(2026, 8, 14, 9, 5, 3))).toBe("09:05:03");
    expect(formatClock(new Date(2026, 8, 14, 14, 32, 10))).toBe("14:32:10");
  });

  it("elige la unidad del intervalo", () => {
    expect(formatInterval(30)).toBe("30 s");
    expect(formatInterval(300)).toBe("5 min");
    expect(formatInterval(90)).toBe("1.5 min");
  });
});

describe("VERSION", () => {
  it("sale de package.json", () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });
});
