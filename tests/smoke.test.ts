import { describe, expect, it } from "vitest";

import { main } from "../src/main.ts";

describe("andamiaje", () => {
  it("expone el punto de entrada", () => {
    expect(typeof main).toBe("function");
  });
});
