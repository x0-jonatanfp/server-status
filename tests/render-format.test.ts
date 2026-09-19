import { describe, expect, it } from "vitest";

import { VERSION } from "../src/infrastructure/config/version.ts";
import {
  displayWidth,
  formatAgo,
  formatBytes,
  formatCelsius,
  formatClock,
  formatInterval,
  formatMilliseconds,
  formatPercent,
  formatShortClock,
  formatUptime,
  NOT_AVAILABLE,
  packEntries,
  progressBar,
} from "../src/domain/services/format.ts";

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
  it("pinta cuadrados, tantos como porcentaje", () => {
    expect(progressBar(0, 10)).toBe("⬜".repeat(10));
    expect(progressBar(100, 10)).toBe("🟪".repeat(10));
    expect(progressBar(12.4, 10)).toBe("🟪" + "⬜".repeat(9));
    expect(progressBar(36, 5)).toBe("🟪🟪⬜⬜⬜");
  });

  it("con consumo mayor que 0 pinta al menos un bloque", () => {
    // Un 2 % en una barra de 10 bloques redondearia a 0 y pareceria vacio.
    expect(progressBar(2, 10)).toBe("🟪" + "⬜".repeat(9));
    expect(progressBar(0.4, 10)).toBe("🟪" + "⬜".repeat(9));
    expect(progressBar(0, 10)).toBe("⬜".repeat(10));
  });

  it("no se sale del numero de bloques ni con datos raros", () => {
    expect(progressBar(200, 5)).toBe("🟪".repeat(5));
    expect(progressBar(-10, 5)).toBe("⬜".repeat(5));
    expect(progressBar(null, 5)).toBe("⬜".repeat(5));
    expect(progressBar(Number.NaN, 5)).toBe("⬜".repeat(5));
  });

  it("ocupa siempre el mismo numero de columnas", () => {
    for (const percent of [0, 12.4, 36, 99.9, 100, null]) {
      expect(displayWidth(progressBar(percent, 7))).toBe(14);
    }
  });
});

describe("displayWidth", () => {
  it("cuenta una columna por caracter normal", () => {
    expect(displayWidth("nginx")).toBe(5);
    expect(displayWidth("postgresql@16-main")).toBe(18);
    expect(displayWidth("CPU\u00A053.6 °C")).toBe(11);
    expect(displayWidth("")).toBe(0);
  });

  it("cuenta dos columnas por emoji y ninguna por el selector de variacion", () => {
    expect(displayWidth("✅ nginx")).toBe(8);
    expect(displayWidth("❌")).toBe(2);
    expect(displayWidth("⚠️")).toBe(2);
    expect(displayWidth("❔")).toBe(2);
    expect(displayWidth("🟪🟪⬜")).toBe(6);
    expect(displayWidth("🗄️ HDD")).toBe(6);
  });
});

describe("packEntries", () => {
  it("mete las entradas que quepan y salta de linea entera", () => {
    expect(packEntries(["aaa", "bbb", "ccc"], { maxWidth: 7 })).toEqual(["aaa bbb", "ccc"]);
  });

  it("nunca parte una entrada, aunque no quepa sola", () => {
    expect(packEntries(["servicio-muy-largo-que-no-cabe"], { maxWidth: 10 })).toEqual([
      "servicio-muy-largo-que-no-cabe",
    ]);
    expect(packEntries(["aaa", "servicio-muy-largo-que-no-cabe"], { maxWidth: 10 })).toEqual([
      "aaa",
      "servicio-muy-largo-que-no-cabe",
    ]);
  });

  it("respeta el separador y la indentacion al medir", () => {
    expect(packEntries(["a", "b", "c"], { maxWidth: 5, separator: " · " })).toEqual([
      "a · b",
      "c",
    ]);
    // La indentacion tambien consume ancho: "  aaa bbb" son 9 columnas.
    expect(packEntries(["aaa", "bbb"], { maxWidth: 7, indent: "  " })).toEqual([
      "  aaa",
      "  bbb",
    ]);
  });

  it("mide los emoji como dos columnas para no pasarse del ancho", () => {
    const entries = ["✅ nginx", "✅ fail2ban"];
    // "✅ nginx ✅ fail2ban" son 8 + 1 + 11 = 20 columnas (cada ✅ ocupa dos).
    expect(packEntries(entries, { maxWidth: 20 })).toEqual(["✅ nginx ✅ fail2ban"]);
    expect(packEntries(entries, { maxWidth: 19 })).toEqual(["✅ nginx", "✅ fail2ban"]);
  });

  it("devuelve una lista vacia sin entradas", () => {
    expect(packEntries([], { maxWidth: 10 })).toEqual([]);
  });
});

describe("formatClock y formatInterval", () => {
  it("da la hora con dos digitos", () => {
    expect(formatClock(new Date(2026, 8, 14, 9, 5, 3))).toBe("09:05:03");
    expect(formatClock(new Date(2026, 8, 14, 14, 32, 10))).toBe("14:32:10");
  });

  it("sin segundos, para el pie del mensaje", () => {
    expect(formatShortClock(new Date(2026, 8, 14, 9, 5, 3))).toBe("09:05");
    expect(formatShortClock(new Date(2026, 8, 14, 14, 32, 10))).toBe("14:32");
  });

  it("elige la unidad del intervalo", () => {
    expect(formatInterval(30)).toBe("30 s");
    expect(formatInterval(300)).toBe("5 min");
    expect(formatInterval(90)).toBe("1.5 min");
  });

  it("mide la antiguedad en segundos o en horas y minutos", () => {
    expect(formatAgo(12)).toBe("hace 12 s");
    expect(formatAgo(59.6)).toBe("hace 60 s");
    expect(formatAgo(60)).toBe("hace 00h 01m");
    expect(formatAgo(3600 + 60)).toBe("hace 01h 01m");
    expect(formatAgo(-5)).toBe("hace 0 s");
  });
});

describe("VERSION", () => {
  it("sale de package.json", () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });
});
