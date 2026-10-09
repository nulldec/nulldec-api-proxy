/**
 * La región de las Edge Functions (`x-region`).
 *
 * Medido el 2026-10-08: las funciones corrían en us-east-1 y la base de datos
 * está en eu-central-1; cada petición de la consola hace varios viajes a ella.
 */
import { describe, expect, it } from "vitest";
import { REGION_POR_DEFECTO, regionDeFunciones } from "./index";

const con = (inicial: Record<string, string> = {}) => new Headers(inicial);

describe("regionDeFunciones", () => {
  it("las funciones van a la región de la base de datos por defecto", () => {
    const h = con();
    regionDeFunciones(h, "/functions/v1/rules/flujos", {});
    expect(h.get("x-region")).toBe(REGION_POR_DEFECTO);
    expect(REGION_POR_DEFECTO).toBe("eu-central-1");
  });

  it("la variable la cambia, y `auto` la quita para salir de una caída", () => {
    const h = con();
    regionDeFunciones(h, "/functions/v1/rules", { FUNCTIONS_REGION: "eu-west-3" });
    expect(h.get("x-region")).toBe("eu-west-3");
    const a = con();
    regionDeFunciones(a, "/functions/v1/rules", { FUNCTIONS_REGION: "auto" });
    expect(a.has("x-region")).toBe(false);
  });

  it("la región la decide el Worker, no quien llama", () => {
    const h = con({ "x-region": "ap-south-1" });
    regionDeFunciones(h, "/functions/v1/rules", {});
    expect(h.get("x-region")).toBe("eu-central-1");
    const rest = con({ "x-region": "ap-south-1" });
    regionDeFunciones(rest, "/rest/v1/alertas", {});
    expect(rest.has("x-region")).toBe(false);
  });

  it("REST, Auth y Realtime no la llevan; un valor mal formado tampoco se manda", () => {
    for (const ruta of ["/rest/v1/alertas", "/auth/v1/user", "/realtime/v1/websocket"]) {
      const h = con();
      regionDeFunciones(h, ruta, {});
      expect(h.has("x-region")).toBe(false);
    }
    const mal = con();
    regionDeFunciones(mal, "/functions/v1/rules", { FUNCTIONS_REGION: "frankfurt; drop" });
    expect(mal.has("x-region")).toBe(false);
  });
});
