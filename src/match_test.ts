/**
 * Pruebas del emparejador de rutas restringidas (tarea 7).
 *
 * El fallo que se arregla: `matchRestrictedPath` usaba `pathname.endsWith(suffix)`.
 * En cuanto una ruta lleva un identificador de por medio —p.ej.
 * `/v1/decoys/abc/test`— deja de casar, y como `checkAndIncrement` falla en
 * abierto, el límite se desactiva en silencio, sin ni un error en los logs.
 *
 * Estas pruebas fallan contra el `matchRestrictedPath(pathname)` anterior
 * (un único argumento, comparación por `endsWith`) porque esa firma ni
 * siquiera acepta el método como argumento — comprobado a mano restaurando
 * temporalmente `src/index.ts` a la versión de la tarea 6 (commit
 * d3b1092bacf0ab6f3b963abdaac4ccce009efaa8) y ejecutando `npx vitest run`:
 * las cuatro pruebas de este fichero fallan (tres por comparación con
 * `endsWith` que nunca casa un patrón con `:id`, una porque la función solo
 * acepta un argumento y el módulo no exporta `pathMatchesPattern`).
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import worker, {
  DEFAULT_BUCKET,
  DEFAULT_LIMIT,
  DEFAULT_WINDOW_SECONDS,
  matchRestrictedPath,
  pathMatchesPattern,
  type Env,
} from "./index";

describe("pathMatchesPattern", () => {
  it("casa un segmento :id con cualquier valor concreto (el caso que endsWith rompía)", () => {
    expect(pathMatchesPattern("/v1/decoys/abc/test", "/v1/decoys/:id/test")).toBe(true);
  });

  it("no casa si el número de segmentos difiere", () => {
    expect(pathMatchesPattern("/v1/decoys/abc/test/extra", "/v1/decoys/:id/test")).toBe(false);
    expect(pathMatchesPattern("/v1/decoys/abc", "/v1/decoys/:id/test")).toBe(false);
  });
});

describe("matchRestrictedPath", () => {
  it("/functions/v1/manage-siem-keys casa igual que /v1/manage-siem-keys (convivencia de prefijos)", () => {
    const viaFunctions = matchRestrictedPath("POST", "/functions/v1/manage-siem-keys");
    const viaV1 = matchRestrictedPath("POST", "/v1/manage-siem-keys");
    expect(viaFunctions).toBeDefined();
    expect(viaV1).toBeDefined();
    expect(viaFunctions?.bucket).toBe("manage-siem-keys");
    expect(viaV1?.bucket).toBe("manage-siem-keys");
  });

  it("el método discrimina: un GET no casa con una entrada declarada POST", () => {
    expect(matchRestrictedPath("POST", "/v1/aws-tenant-deploy-decoy")).toBeDefined();
    expect(matchRestrictedPath("GET", "/v1/aws-tenant-deploy-decoy")).toBeUndefined();
  });

  it("las tres entradas muertas (cli, generate-api-key, list-interactive-credentials) ya no están", () => {
    expect(matchRestrictedPath("POST", "/v1/cli")).toBeUndefined();
    expect(matchRestrictedPath("POST", "/v1/generate-api-key")).toBeUndefined();
    expect(matchRestrictedPath("POST", "/v1/list-interactive-credentials")).toBeUndefined();
  });
});

describe("techo por defecto para rutas no listadas", () => {
  const env: Env = { SUPABASE_HOST: "example.supabase.co", SUPABASE_ANON_KEY: "anon-key" };
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/rest/v1/rpc/rate_limit_check")) {
        return new Response(JSON.stringify(true), { status: 200 });
      }
      // Respuesta genérica para la petición reenviada a Supabase.
      return new Response("ok", { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("una ruta no listada SÍ pasa por rate_limit_check, con el bucket/límite por defecto — no queda sin límite", async () => {
    const request = new Request("https://api.nulldec.com/v1/ruta-no-listada-cualquiera", {
      method: "POST",
      headers: { "cf-connecting-ip": "203.0.113.9" },
    });

    await worker.fetch(request, env);

    const rateLimitCall = fetchMock.mock.calls.find(([input]) =>
      (typeof input === "string" ? input : input.toString()).includes("/rest/v1/rpc/rate_limit_check"),
    );
    expect(rateLimitCall).toBeDefined();

    const [, init] = rateLimitCall as [RequestInfo, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.p_key).toBe(`rl:${DEFAULT_BUCKET}:203.0.113.9`);
    expect(body.p_limit).toBe(DEFAULT_LIMIT);
    expect(body.p_window_seconds).toBe(DEFAULT_WINDOW_SECONDS);
  });
});
