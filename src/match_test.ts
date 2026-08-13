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
  RESTRICTED_PATHS,
  matchRestrictedPath,
  pathMatchesPattern,
  normalizarParaLimite,
  reescribirPrefijoV1,
  tieneTechoPorDefecto,
  type Env,
  type LimiteRuta,
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

  // El mecanismo de discriminación por método existe (lo pide el spec §6 y lo
  // necesitará la fase 2), pero NINGUNA de las nueve entradas reales lo usa:
  // todas declaran "*". Esta prueba verifica el mecanismo con una fixture
  // propia, para no fijar como correcto lo contrario de lo que las entradas
  // reales hacen. La prueba de abajo ("las nueve entradas reales casan con
  // cualquier verbo") es la que cubre las entradas de verdad.
  //
  // La fixture se le PASA a `matchRestrictedPath`: la versión anterior de esta
  // prueba reimplementaba la condición del método sobre un objeto local, así
  // que probaba su propia copia y no la función. Se demostró vacía borrando la
  // comprobación del método de `matchRestrictedPath`: la suite entera seguía
  // en verde.
  const fixtureConMetodo: LimiteRuta[] = [
    { method: "POST", pattern: "/v1/prueba/:id", bucket: "fixture", limit: 1, windowSeconds: 1 },
  ];

  it("el mecanismo del método discrimina cuando una entrada declara un verbo concreto", () => {
    expect(matchRestrictedPath("POST", "/v1/prueba/abc", fixtureConMetodo)?.bucket).toBe("fixture");
    expect(matchRestrictedPath("GET", "/v1/prueba/abc", fixtureConMetodo)).toBeUndefined();
    expect(matchRestrictedPath("DELETE", "/v1/prueba/abc", fixtureConMetodo)).toBeUndefined();
  });

  it("una entrada '*' de la fixture sí casa cualquier verbo — los dos lados del mecanismo", () => {
    const fixtureComodin: LimiteRuta[] = [
      { method: "*", pattern: "/v1/prueba/:id", bucket: "fixture", limit: 1, windowSeconds: 1 },
    ];
    for (const metodo of ["GET", "POST", "DELETE"]) {
      expect(matchRestrictedPath(metodo, "/v1/prueba/abc", fixtureComodin)?.bucket).toBe("fixture");
    }
  });

  it("las nueve entradas reales casan con CUALQUIER verbo — no relajar lo desplegado", () => {
    // Antes de la fase 1 el emparejador casaba por sufijo, sin mirar el
    // método: un `GET /v1/contact-sales` entraba en el cubo de 5/hora igual
    // que un POST. Estrechar una entrada a `method: "POST"` la deja fuera de
    // su cubo estricto para el resto de verbos y la manda al techo por
    // defecto (600/60 s) — una relajación silenciosa de un control vivo.
    for (const entrada of RESTRICTED_PATHS) {
      for (const metodo of ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"]) {
        const m = matchRestrictedPath(metodo, entrada.pattern);
        expect(m, `${metodo} ${entrada.pattern} debería casar su entrada estricta`).toBeDefined();
        expect(m?.bucket).toBe(entrada.bucket);
      }
    }
  });

  it("las tres entradas muertas (cli, generate-api-key, list-interactive-credentials) ya no están", () => {
    expect(matchRestrictedPath("POST", "/v1/cli")).toBeUndefined();
    expect(matchRestrictedPath("POST", "/v1/generate-api-key")).toBeUndefined();
    expect(matchRestrictedPath("POST", "/v1/list-interactive-credentials")).toBeUndefined();
  });
});

/**
 * Instantánea de los nueve cubos.
 *
 * `bucket`, `limit` y `windowSeconds` no son detalles de implementación: son
 * la clave (`rl:<bucket>:<ip>`) de contadores VIVOS en producción. Renombrar un
 * cubo no da error en ningún sitio, simplemente empieza a contar desde cero
 * para todo el mundo — es decir, desactiva el límite durante una ventana
 * entera sin dejar rastro. Esta prueba existe para que ese cambio salga en
 * rojo. Si de verdad se quiere renombrar o reajustar uno, se cambia aquí a
 * propósito y se deja escrito el porqué.
 */
describe("instantánea de los cubos vivos", () => {
  it("los nueve {bucket, limit, windowSeconds} son exactamente estos", () => {
    const instantanea = RESTRICTED_PATHS.map(({ bucket, limit, windowSeconds }) => ({
      bucket,
      limit,
      windowSeconds,
    }));

    expect(instantanea).toEqual([
      { bucket: "aws-tenant-deploy", limit: 5, windowSeconds: 3600 },
      { bucket: "azure-tenant-deploy", limit: 5, windowSeconds: 3600 },
      { bucket: "gh-actions-issue", limit: 60, windowSeconds: 3600 },
      { bucket: "list-net-ids", limit: 3, windowSeconds: 60 },
      { bucket: "manage-siem-keys", limit: 10, windowSeconds: 3600 },
      { bucket: "verify-turnstile", limit: 20, windowSeconds: 3600 },
      { bucket: "contact-sales", limit: 5, windowSeconds: 3600 },
      { bucket: "handle-network-signal", limit: 120, windowSeconds: 60 },
      { bucket: "handle-interactive-signal", limit: 60, windowSeconds: 60 },
    ]);
  });

  it("el cubo por defecto tampoco cambia de nombre ni de forma", () => {
    expect(DEFAULT_BUCKET).toBe("default");
    expect(DEFAULT_LIMIT).toBe(600);
    expect(DEFAULT_WINDOW_SECONDS).toBe(60);
  });
});

/**
 * El techo por defecto alcanza la superficie de API y NADA más.
 *
 * Este Worker proxea el proyecto de Supabase entero: `/rest/v1` es PostgREST y
 * `/auth/v1` es GoTrue, y ahí apuntan su cliente de supabase-js las dos
 * consolas. Un techo universal metería un viaje extra y una escritura en
 * Postgres delante de cada lectura de la consola.
 */
describe("tieneTechoPorDefecto", () => {
  it("la superficie de API sí: /v1/ y /functions/v1/", () => {
    expect(tieneTechoPorDefecto("/v1/verify-turnstile")).toBe(true);
    expect(tieneTechoPorDefecto("/functions/v1/verify-turnstile")).toBe(true);
  });

  it("el resto de la superficie de Supabase no", () => {
    expect(tieneTechoPorDefecto("/rest/v1/alerts?select=*")).toBe(false);
    expect(tieneTechoPorDefecto("/auth/v1/token")).toBe(false);
    expect(tieneTechoPorDefecto("/realtime/v1/websocket")).toBe(false);
    expect(tieneTechoPorDefecto("/storage/v1/object/informes/x.pdf")).toBe(false);
  });

  it("'/v1' a secas, sin barra, no es la superficie de API", () => {
    expect(tieneTechoPorDefecto("/v1")).toBe(false);
  });

  it("con las barras ya colapsadas, la forma con barra de más sí es superficie de API", () => {
    expect(tieneTechoPorDefecto(normalizarParaLimite("//v1/algo"))).toBe(true);
    expect(tieneTechoPorDefecto(normalizarParaLimite("///functions/v1/algo"))).toBe(true);
  });
});

describe("normalizarParaLimite", () => {
  it("colapsa cualquier repetición de barras", () => {
    expect(normalizarParaLimite("//functions/v1/contact-sales")).toBe("/functions/v1/contact-sales");
    expect(normalizarParaLimite("///v1/algo")).toBe("/v1/algo");
    expect(normalizarParaLimite("/v1//algo///otro")).toBe("/v1/algo/otro");
  });

  it("no toca una ruta ya normal", () => {
    expect(normalizarParaLimite("/v1/contact-sales")).toBe("/v1/contact-sales");
    expect(normalizarParaLimite("/rest/v1/alerts")).toBe("/rest/v1/alerts");
  });
});

describe("techo por defecto para rutas no listadas", () => {
  const env: Env = { SUPABASE_HOST: "example.supabase.co", SUPABASE_ANON_KEY: "anon-key" };
  let fetchMock: ReturnType<typeof vi.fn>;

  function urlDeEntrada(input: RequestInfo | URL): string {
    if (typeof input === "string") return input;
    if (input instanceof Request) return input.url;
    return input.toString();
  }

  const llamadasAlLimite = () =>
    fetchMock.mock.calls.filter(([input]) =>
      urlDeEntrada(input).includes("/rest/v1/rpc/rate_limit_check"),
    );

  beforeEach(() => {
    fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = urlDeEntrada(input);
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

    const rateLimitCall = llamadasAlLimite()[0];
    expect(rateLimitCall).toBeDefined();

    const [, init] = rateLimitCall as [RequestInfo, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.p_key).toBe(`rl:${DEFAULT_BUCKET}:203.0.113.9`);
    expect(body.p_limit).toBe(DEFAULT_LIMIT);
    expect(body.p_window_seconds).toBe(DEFAULT_WINDOW_SECONDS);
  });

  // --- Barras repetidas: la forma que se saltaba TODOS los límites ---
  //
  // Cloudflare entrega el pathname sin colapsar las barras y esa forma llega a
  // la función real (verificado contra producción: `//functions/v1/<lo que
  // sea>` devuelve el NOT_FOUND del router de Supabase, no un error del
  // borde). Sin normalizar, `//functions/v1/contact-sales` no casaba su
  // entrada estricta (3 segmentos contra 2) ni la superficie de API, así que
  // no se llamaba a la RPC en absoluto: ni cubo de 5/hora ni techo por
  // defecto. Cero límite con una tecla de más, y alcanzaba a las dos rutas que
  // crean recursos de pago reales.

  it("//functions/v1/contact-sales cae en su cubo estricto, no se escapa del límite", async () => {
    await worker.fetch(
      new Request("https://api.nulldec.com//functions/v1/contact-sales", {
        method: "POST",
        headers: { "cf-connecting-ip": "203.0.113.9" },
      }),
      env,
    );

    const [llamada] = llamadasAlLimite();
    expect(llamada, "debe llamarse a la RPC: esta forma no puede quedar sin límite").toBeDefined();
    const [, init] = llamada as [RequestInfo, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.p_key).toBe("rl:contact-sales:203.0.113.9");
    expect(body.p_limit).toBe(5);
    expect(body.p_window_seconds).toBe(3600);
  });

  it("//v1/contact-sales también cae en su cubo estricto", async () => {
    await worker.fetch(
      new Request("https://api.nulldec.com//v1/contact-sales", {
        method: "POST",
        headers: { "cf-connecting-ip": "203.0.113.9" },
      }),
      env,
    );

    const [llamada] = llamadasAlLimite();
    expect(llamada).toBeDefined();
    const [, init] = llamada as [RequestInfo, RequestInit];
    expect(JSON.parse(init.body as string).p_key).toBe("rl:contact-sales:203.0.113.9");
  });

  it("///v1/algo-no-listado cae en el techo por defecto, no en la nada", async () => {
    await worker.fetch(
      new Request("https://api.nulldec.com///v1/algo-no-listado", {
        method: "POST",
        headers: { "cf-connecting-ip": "203.0.113.9" },
      }),
      env,
    );

    const [llamada] = llamadasAlLimite();
    expect(llamada).toBeDefined();
    const [, init] = llamada as [RequestInfo, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.p_key).toBe(`rl:${DEFAULT_BUCKET}:203.0.113.9`);
    expect(body.p_limit).toBe(DEFAULT_LIMIT);
  });

  it("las dos rutas de despliegue en la nube tampoco se escapan con barra de más", async () => {
    // Son las que crean recursos de pago reales (5/hora). Se comprueban las
    // dos explícitamente porque son el peor caso de este agujero.
    for (const ruta of ["aws-tenant-deploy-decoy", "azure-tenant-deploy-decoy"]) {
      fetchMock.mockClear();
      await worker.fetch(
        new Request(`https://api.nulldec.com//functions/v1/${ruta}`, {
          method: "POST",
          headers: { "cf-connecting-ip": "203.0.113.9" },
        }),
        env,
      );
      const [llamada] = llamadasAlLimite();
      expect(llamada, `${ruta} debe pagar su límite`).toBeDefined();
      const [, init] = llamada as [RequestInfo, RequestInit];
      expect(JSON.parse(init.body as string).p_limit).toBe(5);
    }
  });

  it("la normalización es SOLO para decidir: se reenvía el pathname original, con sus barras", async () => {
    // El Worker no decide qué es "la misma ruta" para Supabase — eso es del
    // router de funciones. Normalizar la URL saliente cambiaría el destino de
    // la petición, no su límite, y la fase 1 se compromete a no tocar el
    // reenvío de ninguna ruta.
    await worker.fetch(
      new Request("https://api.nulldec.com//functions/v1/contact-sales", {
        method: "POST",
        headers: { "cf-connecting-ip": "203.0.113.9" },
      }),
      env,
    );

    const reenviada = fetchMock.mock.calls.find(
      ([input]) =>
        urlDeEntrada(input).includes("example.supabase.co") &&
        !urlDeEntrada(input).includes("rate_limit_check"),
    );
    expect(reenviada).toBeDefined();
    const [entrada] = reenviada as [RequestInfo];
    expect(urlDeEntrada(entrada)).toBe("https://example.supabase.co//functions/v1/contact-sales");
  });

  it("una lectura de PostgREST NO paga el límite: se reenvía sin llamar a la RPC", async () => {
    const request = new Request("https://api.nulldec.com/rest/v1/alerts?select=*", {
      method: "GET",
      headers: { "cf-connecting-ip": "203.0.113.9" },
    });

    await worker.fetch(request, env);

    expect(llamadasAlLimite()).toHaveLength(0);
    // …y aun así se reenvía, que es el comportamiento previo a la fase 1.
    const reenviada = fetchMock.mock.calls.find(([input]) =>
      urlDeEntrada(input).includes("example.supabase.co/rest/v1/alerts"),
    );
    expect(reenviada).toBeDefined();
  });

  it("/auth/v1 tampoco paga el límite", async () => {
    const request = new Request("https://api.nulldec.com/auth/v1/token?grant_type=password", {
      method: "POST",
      headers: { "cf-connecting-ip": "203.0.113.9" },
    });

    await worker.fetch(request, env);

    expect(llamadasAlLimite()).toHaveLength(0);
  });
});

/**
 * El fallo EN ABIERTO de `checkAndIncrement`, y el 429.
 *
 * El fallo en abierto es deliberado y es la invariante que más tentación da de
 * «arreglar» porque leída sola parece un bug: si la RPC falla, se deja pasar.
 * La autenticación real de estas rutas es el secreto/JWT, no el límite, así que
 * un hipo de Postgres no debe convertirse en un corte de tráfico legítimo.
 * Sin estas pruebas, cambiarlo a `return false` no rompía nada en verde.
 */
describe("comportamiento de checkAndIncrement ante fallo y ante límite alcanzado", () => {
  const env: Env = { SUPABASE_HOST: "example.supabase.co", SUPABASE_ANON_KEY: "anon-key" };

  function urlDeEntrada(input: RequestInfo | URL): string {
    if (typeof input === "string") return input;
    if (input instanceof Request) return input.url;
    return input.toString();
  }

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  /** Silencia el console.error del camino de fallo para no ensuciar la salida. */
  function callarError() {
    vi.spyOn(console, "error").mockImplementation(() => {});
  }

  it("si la RPC devuelve 500, la petición SE DEJA PASAR (falla en abierto), no se corta", async () => {
    callarError();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (urlDeEntrada(input).includes("/rest/v1/rpc/rate_limit_check")) {
        return new Response("boom", { status: 500 });
      }
      return new Response("ok-upstream", { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const res = await worker.fetch(
      new Request("https://api.nulldec.com/v1/contact-sales", {
        method: "POST",
        headers: { "cf-connecting-ip": "203.0.113.9" },
      }),
      env,
    );

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok-upstream");
    const reenviada = fetchMock.mock.calls.find(
      ([input]) =>
        urlDeEntrada(input).includes("example.supabase.co") &&
        !urlDeEntrada(input).includes("rate_limit_check"),
    );
    expect(reenviada, "la petición debe llegar a upstream pese al fallo del límite").toBeDefined();
  });

  it("si la RPC lanza (fallo de red), la petición también se deja pasar", async () => {
    callarError();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (urlDeEntrada(input).includes("/rest/v1/rpc/rate_limit_check")) {
        throw new TypeError("network error");
      }
      return new Response("ok-upstream", { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const res = await worker.fetch(
      new Request("https://api.nulldec.com/v1/contact-sales", {
        method: "POST",
        headers: { "cf-connecting-ip": "203.0.113.9" },
      }),
      env,
    );

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok-upstream");
  });

  it("si la RPC devuelve false, responde 429 con retry-after y la cabecera expuesta a CORS", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (urlDeEntrada(input).includes("/rest/v1/rpc/rate_limit_check")) {
        return new Response(JSON.stringify(false), { status: 200 });
      }
      return new Response("ok-upstream", { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const res = await worker.fetch(
      new Request("https://api.nulldec.com/v1/contact-sales", {
        method: "POST",
        headers: { "cf-connecting-ip": "203.0.113.9" },
      }),
      env,
    );

    expect(res.status).toBe(429);
    // 3600 s: la ventana del cubo contact-sales, no la del techo por defecto.
    expect(res.headers.get("retry-after")).toBe("3600");
    expect(res.headers.get("access-control-expose-headers")).toBe("retry-after");
    expect((await res.json()).error).toContain("límite");
    // Y, cortada, NO se reenvía a upstream.
    const reenviada = fetchMock.mock.calls.find(
      ([input]) =>
        urlDeEntrada(input).includes("example.supabase.co") &&
        !urlDeEntrada(input).includes("rate_limit_check"),
    );
    expect(reenviada).toBeUndefined();
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
