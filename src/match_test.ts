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
  reescribirPrefijoV1,
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

/**
 * Pruebas de `reescribirPrefijoV1` (tarea 8): la reescritura `/v1/*` →
 * `/functions/v1/*`. Los tres casos que pide el brief, más los casos
 * frontera pensados aparte: una ruta que es exactamente `/v1` sin barra
 * final (no debe casar el prefijo `/v1/`), una que contiene `/v1/` más
 * adelante en la ruta y no al principio (no debe tocarse — esto es una
 * regla de prefijo, no una sustitución global sobre el string), y que la
 * cadena de consulta sobreviva.
 */
describe("reescribirPrefijoV1", () => {
  it("/v1/verify-turnstile -> /functions/v1/verify-turnstile", () => {
    expect(reescribirPrefijoV1("/v1/verify-turnstile")).toBe("/functions/v1/verify-turnstile");
  });

  it("/functions/v1/verify-turnstile no cambia — convivencia, no sustitución", () => {
    expect(reescribirPrefijoV1("/functions/v1/verify-turnstile")).toBe("/functions/v1/verify-turnstile");
  });

  it("/v1/decoys/abc/test -> /functions/v1/decoys/abc/test", () => {
    expect(reescribirPrefijoV1("/v1/decoys/abc/test")).toBe("/functions/v1/decoys/abc/test");
  });

  it("caso frontera: '/v1' a secas, sin barra final, no casa el prefijo '/v1/' y no se toca", () => {
    expect(reescribirPrefijoV1("/v1")).toBe("/v1");
  });

  it("caso frontera: un '/v1/' que aparece más adelante en la ruta no se toca — regla de prefijo, no sustitución global", () => {
    expect(reescribirPrefijoV1("/functions/v1/algo/v1/otro")).toBe("/functions/v1/algo/v1/otro");
  });

  it("caso frontera: la cadena de consulta sobrevive — la reescritura opera solo sobre pathname, vía URL", () => {
    const url = new URL("https://api.nulldec.com/v1/verify-turnstile?foo=bar&baz=1");
    url.pathname = reescribirPrefijoV1(url.pathname);
    expect(url.pathname).toBe("/functions/v1/verify-turnstile");
    expect(url.search).toBe("?foo=bar&baz=1");
  });

  // El fragmento (#...) no viaja nunca en la petición HTTP real que le
  // llega al Worker — es puramente del lado del cliente (RFC 3986 §3.5),
  // así que `request.url` jamás lo trae en producción; esta prueba es
  // documental, no una garantía de un caso que vaya a ocurrir. Se deja
  // igualmente porque el brief pide pensar el caso, y confirma que, si
  // alguna vez hubiera un `URL` con `hash`, la reescritura —que solo toca
  // `pathname`— no lo alteraría.
  it("caso frontera (documental): un fragmento no se ve afectado — nunca llega al Worker en una petición HTTP real", () => {
    const url = new URL("https://api.nulldec.com/v1/verify-turnstile#seccion");
    url.pathname = reescribirPrefijoV1(url.pathname);
    expect(url.pathname).toBe("/functions/v1/verify-turnstile");
    expect(url.hash).toBe("#seccion");
  });
});

describe("la reescritura se aplica al reenviar (integración con worker.fetch)", () => {
  const env: Env = { SUPABASE_HOST: "example.supabase.co", SUPABASE_ANON_KEY: "anon-key" };
  let fetchMock: ReturnType<typeof vi.fn>;

  function urlDe(input: RequestInfo | URL): string {
    if (typeof input === "string") return input;
    if (input instanceof Request) return input.url;
    return input.toString();
  }

  beforeEach(() => {
    fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = urlDe(input);
      if (url.includes("/rest/v1/rpc/rate_limit_check")) {
        return new Response(JSON.stringify(true), { status: 200 });
      }
      return new Response("ok", { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("/v1/verify-turnstile se reenvía a .../functions/v1/verify-turnstile, con la query intacta", async () => {
    const request = new Request("https://api.nulldec.com/v1/verify-turnstile?token=xyz", {
      method: "POST",
      headers: { "cf-connecting-ip": "203.0.113.9" },
    });

    await worker.fetch(request, env);

    const proxiedCall = fetchMock.mock.calls.find(
      ([input]) => urlDe(input).includes("example.supabase.co") && !urlDe(input).includes("rate_limit_check"),
    );
    expect(proxiedCall).toBeDefined();
    const [proxiedInput] = proxiedCall as [RequestInfo];
    expect(urlDe(proxiedInput)).toBe("https://example.supabase.co/functions/v1/verify-turnstile?token=xyz");
  });

  it("/functions/v1/verify-turnstile se reenvía sin cambios", async () => {
    const request = new Request("https://api.nulldec.com/functions/v1/verify-turnstile", {
      method: "POST",
      headers: { "cf-connecting-ip": "203.0.113.9" },
    });

    await worker.fetch(request, env);

    const proxiedCall = fetchMock.mock.calls.find(
      ([input]) => urlDe(input).includes("example.supabase.co") && !urlDe(input).includes("rate_limit_check"),
    );
    expect(proxiedCall).toBeDefined();
    const [proxiedInput] = proxiedCall as [RequestInfo];
    expect(urlDe(proxiedInput)).toBe("https://example.supabase.co/functions/v1/verify-turnstile");
  });
});
