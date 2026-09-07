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
  cabecerasHaciaSupabase,
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
  // Lo que se prueba aqui es la NORMALIZACION del prefijo, no las claves SIEM:
  // las dos formas de escribir la misma ruta tienen que caer en el mismo cubo, o
  // quien conozca las dos se lleva el doble de limite. Usaba
  // `/v1/manage-siem-keys` como sujeto; esa ruta murio con la funcion el
  // 2026-09-03, asi que ahora usa la que la sustituyo.
  it("/functions/v1/keys/siem casa igual que /v1/keys/siem (convivencia de prefijos)", () => {
    const viaFunctions = matchRestrictedPath("POST", "/functions/v1/keys/siem");
    const viaV1 = matchRestrictedPath("POST", "/v1/keys/siem");
    expect(viaFunctions).toBeDefined();
    expect(viaV1).toBeDefined();
    expect(viaFunctions?.bucket).toBe("manage-siem-keys");
    expect(viaV1?.bucket).toBe("manage-siem-keys");
  });

  // El mecanismo de discriminación por método existe (lo pide el spec §6 y lo
  // necesitará la fase 2), pero NINGUNA de las once entradas reales lo usa:
  // todas declaran "*". Esta prueba verifica el mecanismo con una fixture
  // propia, para no fijar como correcto lo contrario de lo que las entradas
  // reales hacen. La prueba de abajo ("las once entradas reales casan con
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

  it("las once entradas reales casan con CUALQUIER verbo — no relajar lo desplegado", () => {
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
 * Instantánea de las dieciséis ENTRADAS, que son CATORCE cubos: `passkeys`
 * aparece tres veces, una por cada forma de su ruta, y las tres comparten
 * contador a propósito. Por eso el rótulo cuenta entradas y no cubos — la
 * instantánea mapea el array, y colapsar las tres filas escondería justo lo
 * que hay que vigilar.
 *
 * Eran once entradas hasta el 2026-09-04, cuando `/v1/keys/agent/enrollment`,
 * `/v1/preferences/test` y las tres de `passkeys` estrenaron cubo. Eran doce
 * hasta el 2026-09-03:
 * `manage-siem-keys` salía dos veces, una por cada forma de la ruta de claves
 * SIEM, y la vieja se fue con la Edge Function. Dieciocho desde el
 * 2026-09-04: las dos rutas de la documentación privada.
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
  it("las dieciocho entradas —dieciséis cubos— son exactamente estas", () => {
    const instantanea = RESTRICTED_PATHS.map(({ bucket, limit, windowSeconds }) => ({
      bucket,
      limit,
      windowSeconds,
    }));

    expect(instantanea).toEqual([
      // Subido de 5 a 20/hora el 2026-08-27, a petición explícita del
      // cliente que probaba BYOIaaS-AWS en real: 5/hora no daba margen para
      // iterar corrigiendo la plantilla CloudFormation del lado del
      // cliente. azure-tenant-deploy se queda en 5 — nadie ha pedido subirlo
      // y sigue siendo la cifra deliberada de la fase 1.
      { bucket: "aws-tenant-deploy", limit: 20, windowSeconds: 3600 },
      { bucket: "azure-tenant-deploy", limit: 5, windowSeconds: 3600 },
      { bucket: "gh-actions-issue", limit: 60, windowSeconds: 3600 },
      { bucket: "list-net-ids", limit: 3, windowSeconds: 60 },
      // Una sola entrada desde el 2026-09-03. El NOMBRE del cubo se conserva
      // aunque la ruta se llame ya `/v1/keys/siem`: `rl:manage-siem-keys:<ip>`
      // son contadores vivos y renombrarlo los pone a cero sin avisar.
      { bucket: "manage-siem-keys", limit: 10, windowSeconds: 3600 },
      // Un token de enrolamiento da de alta AGENTES en la organización entera:
      // más alcance que una clave SIEM, mismo techo. 10/hora sobra para una
      // campaña de despliegue, que es el caso real.
      { bucket: "agent-enrollment", limit: 10, windowSeconds: 3600 },
      // Las dos de la documentación privada, añadidas el 2026-09-04. Cubos
      // SEPARADOS a propósito: una emite credenciales de entrada desde un
      // navegador y la otra la llama el servidor de docs. Con un cubo
      // compartido, abusar de la primera dejaría a todo el mundo sin poder
      // canjear.
      //
      // `docs-sesion` es alto (600/60 s) porque el cubo es por IP y TODAS las
      // llamadas legítimas salen de las mismas IPs —los datacenters de
      // Cloudflare Pages—, así que un techo estrecho lo agotaría el tráfico
      // bueno de toda la clientela junta. Quien no tenga el secreto compartido
      // recibe 401 igual.
      { bucket: "docs-ticket", limit: 60, windowSeconds: 3600 },
      { bucket: "docs-sesion", limit: 600, windowSeconds: 60 },
      // Manda correo, Telegram y Slack de verdad. 20 y no 5 como
      // `contact-sales` porque aquí hace falta sesión —el llamante es un
      // cliente identificado— y comprobar un canal recién configurado se hace
      // varias veces seguidas.
      { bucket: "preferences-test", limit: 20, windowSeconds: 3600 },
      { bucket: "verify-turnstile", limit: 20, windowSeconds: 3600 },
      { bucket: "contact-sales", limit: 5, windowSeconds: 3600 },
      { bucket: "handle-network-signal", limit: 120, windowSeconds: 60 },
      { bucket: "handle-interactive-signal", limit: 60, windowSeconds: 60 },
      // Añadidos el 2026-08-18 al cerrar la superficie del Agente. Los dos
      // estaban en el techo por defecto (600/60 s) y no debían:
      //   agent-enroll es PÚBLICO y CREA FILAS, autenticado por un token que
      //     viaja en el paquete MSI de toda la organización — hay que asumir
      //     que se filtra. 120/min contempla el NAT (500 máquinas de una sede
      //     salen por la misma IP) y baja el techo de abuso de 36.000 a 7.200
      //     altas/hora.
      //   handle-agent-signal es ingesta, hermano de los dos de arriba, y era
      //     el único de los tres sin límite propio.
      { bucket: "agent-enroll", limit: 120, windowSeconds: 60 },
      { bucket: "handle-agent-signal", limit: 120, windowSeconds: 60 },
      // Tres entradas, UN cubo. Tres porque el recurso tiene tres formas y el
      // casado es estricto por número de segmentos; un cubo porque el límite
      // es del recurso, no de cada forma de llamarlo.
      { bucket: "passkeys", limit: 120, windowSeconds: 60 },
      { bucket: "passkeys", limit: 120, windowSeconds: 60 },
      { bucket: "passkeys", limit: 120, windowSeconds: 60 },
    ]);
  });

  it("el cubo por defecto tampoco cambia de nombre ni de forma", () => {
    expect(DEFAULT_BUCKET).toBe("default");
    expect(DEFAULT_LIMIT).toBe(600);
    expect(DEFAULT_WINDOW_SECONDS).toBe(60);
  });
});

describe("passkeys: las tres formas del recurso tienen cubo", () => {
  // Esto es lo que se rompe si alguien colapsa las tres entradas en una:
  // las rutas que no casen caen al techo por defecto (600/60 s) SIN NINGÚN
  // síntoma. Es la misma trampa que dejó `manage-siem-keys` sin límite.
  const conCubo = (metodo: string, ruta: string) =>
    matchRestrictedPath(metodo, ruta)?.bucket;

  it("la lista, el borrado y las cuatro POST caen todas en el cubo passkeys", () => {
    expect(conCubo("GET", "/v1/passkeys")).toBe("passkeys");
    expect(conCubo("DELETE", "/v1/passkeys/1f8c9e0a-1111-2222-3333-444455556666")).toBe("passkeys");
    for (const r of [
      "/v1/passkeys/registro/opciones",
      "/v1/passkeys/registro/verificar",
      "/v1/passkeys/step-up/opciones",
      "/v1/passkeys/step-up/verificar",
    ]) {
      expect(conCubo("POST", r)).toBe("passkeys");
    }
  });

  it("también con el prefijo viejo /functions/v1/", () => {
    // El Worker acepta las dos formas; si solo casara la nueva, cualquiera
    // podría esquivar el techo escribiendo la vieja.
    expect(conCubo("POST", "/functions/v1/passkeys/step-up/opciones")).toBe("passkeys");
    expect(conCubo("GET", "/functions/v1/passkeys")).toBe("passkeys");
  });

  it("no se pisa con el otro patrón de cuatro segmentos que hay ahora", () => {
    // `/v1/passkeys/:accion/:fase` y `/v1/keys/agent/enrollment` tienen el
    // mismo número de segmentos y llegaron con dos semanas de diferencia. El
    // literal del segundo segmento (`passkeys` vs `keys`) es lo único que los
    // separa, así que se afirma en vez de darse por hecho: un comodín de más
    // en cualquiera de los dos se llevaría el tráfico del otro a su contador,
    // y el síntoma sería un límite que salta antes de tiempo en la ruta
    // equivocada — de los que cuesta días atribuir.
    expect(conCubo("POST", "/v1/keys/agent/enrollment")).toBe("agent-enrollment");
    expect(conCubo("POST", "/v1/passkeys/registro/opciones")).toBe("passkeys");
  });

  it("una ruta de passkeys más profunda NO cae en el cubo — y hay que saberlo", () => {
    // 5 segmentos no casa ninguna de las tres entradas. Hoy no existe ninguna
    // ruta así; si mañana se añade, esta prueba obliga a declararle cubo en
    // vez de dejarla caer callando al techo por defecto.
    expect(conCubo("POST", "/v1/passkeys/step-up/opciones/extra")).toBeUndefined();
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
    // Son las que crean recursos de pago reales. Se comprueban las dos
    // explícitamente porque son el peor caso de este agujero — cada una con
    // su propio límite (ver la instantánea de los cubos de arriba para el
    // porqué de que ya no sean el mismo número).
    for (const [ruta, limiteEsperado] of [
      ["aws-tenant-deploy-decoy", 20],
      ["azure-tenant-deploy-decoy", 5],
    ] as const) {
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
      expect(JSON.parse(init.body as string).p_limit).toBe(limiteEsperado);
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

describe("las claves SIEM", () => {
  // El emparejador exige MISMO NUMERO DE SEGMENTOS, asi que
  // `/v1/manage-siem-keys` (2) no casaba nunca con `/v1/keys/siem` (3). Al
  // migrar el recurso `keys` a `/v1/`, la generacion de claves SIEM dejo de
  // tener su cubo de 10/hora y se cayo al techo por defecto: 600/60 s, o sea
  // 3.600 veces mas margen para generar credenciales de maquina. Esta prueba es
  // lo que impide que vuelva a pasar.
  it("la ruta tiene limite propio, no el techo por defecto", () => {
    const regla = matchRestrictedPath("POST", "/v1/keys/siem");
    expect(regla, "/v1/keys/siem se ha quedado sin limite propio").toBeDefined();
    expect(regla?.limit).toBe(10);
    expect(regla?.windowSeconds).toBe(3600);
  });

  // La forma vieja se retiro con la Edge Function `manage-siem-keys` el
  // 2026-09-03. Que ya no case NO la deja sin techo: cae al limite por defecto
  // del Worker, y detras no hay funcion — es un 404. Se afirma para que quede
  // claro que la ausencia es deliberada y no un patron que se cayo al editar.
  it("la ruta VIEJA ya no tiene regla propia: se retiro con su funcion", () => {
    expect(matchRestrictedPath("POST", "/v1/manage-siem-keys")).toBeUndefined();
    expect(matchRestrictedPath("POST", "/functions/v1/manage-siem-keys")).toBeUndefined();
  });
});

/**
 * Los dos cubos que estrenaron el 2026-09-04, y el hueco DELIBERADO que dejan.
 *
 * Las dos rutas nacieron al migrar las últimas acciones de
 * `manage-notifications` y `manage-agent-keys` a sus recursos `/v1/`. Sin línea
 * aquí habrían caído al techo por defecto (600/60 s), que es el mismo agujero
 * que las claves SIEM tuvieron durante una fase entera sin que nadie lo notara:
 * este Worker falla en ABIERTO cuando no encuentra patrón, así que una ruta
 * nueva sin cubo no da error, da barra libre.
 */
describe("los cubos de enrolamiento de agente y prueba de canales", () => {
  it("emitir un token de alta tiene techo propio, no el de por defecto", () => {
    const regla = matchRestrictedPath("POST", "/v1/keys/agent/enrollment");
    expect(regla, "/v1/keys/agent/enrollment se ha quedado sin límite propio").toBeDefined();
    expect(regla?.limit).toBe(10);
    expect(regla?.windowSeconds).toBe(3600);
  });

  it("la forma con prefijo viejo casa igual", () => {
    // `normalizarRuta` reescribe `/functions/v1/...` a `/v1/...` antes de
    // comparar, y las dos formas siguen vivas mientras la consola migra.
    expect(matchRestrictedPath("POST", "/functions/v1/keys/agent/enrollment")).toBeDefined();
  });

  it("el envío de prueba tiene techo propio", () => {
    const regla = matchRestrictedPath("POST", "/v1/preferences/test");
    expect(regla, "/v1/preferences/test se ha quedado sin límite propio").toBeDefined();
    expect(regla?.limit).toBe(20);
    expect(regla?.windowSeconds).toBe(3600);
  });

  it("REVOCAR un token NO tiene cubo, y es a propósito", () => {
    // `pathMatchesPattern` exige mismo número de segmentos, así que
    // `/v1/keys/agent/enrollment/:id` (cuatro) no casa con el patrón de tres.
    // Es exactamente la clase de detalle que dejó a las claves SIEM sin techo,
    // así que se afirma en vez de suponerse.
    //
    // Aquí la ausencia es correcta: revocar solo QUITA capacidad. Un abuso de
    // esta ruta no emite nada ni escribe a terceros — como mucho revoca tokens
    // de la propia organización, que ya requiere sesión de admin. Ponerle un
    // techo estrecho sería, además, empujar a no cerrar la puerta.
    expect(matchRestrictedPath("DELETE", "/v1/keys/agent/enrollment/tok-1")).toBeUndefined();
  });

  it("y no se comen las rutas vecinas de `keys`", () => {
    // El patrón de tres segmentos no puede robarle nada a `/v1/keys/siem` ni
    // al listado genérico `/v1/keys/agent`.
    expect(matchRestrictedPath("GET", "/v1/keys/siem")?.bucket).toBe("manage-siem-keys");
    expect(matchRestrictedPath("GET", "/v1/keys/agent")).toBeUndefined();
  });
});

/**
 * La IP real hacia Supabase (deuda técnica §5.46).
 *
 * `cf-connecting-ip` no sobrevive al salto a Supabase: su Cloudflare la
 * sobrescribe con el par de conexión, que en este camino es este Worker. Las
 * Edge Functions veían siempre un rango de Cloudflare, así que sus límites de
 * tasa —que se creen por cliente— eran GLOBALES.
 *
 * Lo que se prueba aquí es sobre todo lo que NO puede pasar: que la cabecera
 * salga sin secreto, o que sobreviva la que mandó quien llama. Cualquiera de
 * las dos convierte todos los límites en decorativos, porque bastaría con
 * mandar una IP distinta en cada petición para tener un cubo nuevo cada vez.
 */
describe("la IP real hacia Supabase", () => {
  const CON_SECRETO: Env = {
    SUPABASE_HOST: "example.supabase.co",
    SUPABASE_ANON_KEY: "anon-key",
    PROXY_SHARED_SECRET: "secreto-del-borde",
  };
  const SIN_SECRETO: Env = { SUPABASE_HOST: "example.supabase.co", SUPABASE_ANON_KEY: "anon-key" };

  const peticion = (cabeceras: Record<string, string>) =>
    new Request("https://api.nulldec.com/v1/sso/resolver", {
      method: "POST",
      headers: { "content-type": "application/json", ...cabeceras },
      body: JSON.stringify({ email: "sonda@example.com" }),
    });

  it("con secreto, manda x-real-ip y x-nd-proxy", () => {
    const h = cabecerasHaciaSupabase(peticion({ "cf-connecting-ip": "203.0.113.9" }), CON_SECRETO, "203.0.113.9");
    expect(h.get("x-real-ip")).toBe("203.0.113.9");
    expect(h.get("x-nd-proxy")).toBe("secreto-del-borde");
  });

  it("SIN secreto configurado, no manda ninguna de las dos", () => {
    // Es lo que permite desplegar backend primero y Worker después: la Edge
    // Function no recibe nada que creerse y cae a `cf-connecting-ip`, el
    // comportamiento de antes.
    const h = cabecerasHaciaSupabase(peticion({ "cf-connecting-ip": "203.0.113.9" }), SIN_SECRETO, "203.0.113.9");
    expect(h.get("x-real-ip")).toBeNull();
    expect(h.get("x-nd-proxy")).toBeNull();
  });

  it("EL CASO QUE IMPORTA: las cabeceras que mandó quien llama se BORRAN", () => {
    // Sin este borrado, quien llama a api.nulldec.com con su propio par
    // `x-nd-proxy` + `x-real-ip` lo tendría intacto al otro lado si el Worker
    // no tiene secreto — y con el secreto acertado, elegiría su cubo de
    // límite en cada petición.
    const h = cabecerasHaciaSupabase(
      peticion({ "cf-connecting-ip": "203.0.113.9", "x-real-ip": "1.2.3.4", "x-nd-proxy": "inventado" }),
      SIN_SECRETO,
      "203.0.113.9",
    );
    expect(h.get("x-real-ip")).toBeNull();
    expect(h.get("x-nd-proxy")).toBeNull();
  });

  it("con secreto, la x-real-ip de quien llama se SUSTITUYE por la de verdad", () => {
    const h = cabecerasHaciaSupabase(
      peticion({ "cf-connecting-ip": "203.0.113.9", "x-real-ip": "1.2.3.4" }),
      CON_SECRETO,
      "203.0.113.9",
    );
    expect(h.get("x-real-ip")).toBe("203.0.113.9");
  });

  it("sin IP de cliente conocida no se afirma ninguna", () => {
    // `clientIp` vale "unknown" cuando `cf-connecting-ip` no llega, y mandar
    // eso como IP real crearía un cubo llamado `unknown` que parecería una
    // dirección. Mejor que la Edge Function caiga a su propia lectura.
    const h = cabecerasHaciaSupabase(peticion({}), CON_SECRETO, "unknown");
    expect(h.get("x-real-ip")).toBeNull();
    expect(h.get("x-nd-proxy")).toBeNull();
  });

  it("el resto de cabeceras sobrevive al reenvío", () => {
    const h = cabecerasHaciaSupabase(
      peticion({ "cf-connecting-ip": "203.0.113.9", authorization: "Bearer x", apikey: "k" }),
      CON_SECRETO,
      "203.0.113.9",
    );
    expect(h.get("authorization")).toBe("Bearer x");
    expect(h.get("apikey")).toBe("k");
    expect(h.get("content-type")).toBe("application/json");
  });

  it("de punta a punta: la petición reenviada a Supabase lleva la IP real", async () => {
    const llamadas: Request[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof Request ? input.url : input.toString();
      if (url.includes("/rest/v1/rpc/rate_limit_check")) return new Response("true", { status: 200 });
      if (input instanceof Request) llamadas.push(input);
      return new Response("ok", { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      await worker.fetch(peticion({ "cf-connecting-ip": "203.0.113.9" }), CON_SECRETO);
      const reenviada = llamadas[0];
      expect(reenviada).toBeDefined();
      expect(reenviada.url).toContain("example.supabase.co");
      expect(reenviada.headers.get("x-real-ip")).toBe("203.0.113.9");
      expect(reenviada.headers.get("x-nd-proxy")).toBe("secreto-del-borde");
      // Y el cuerpo sigue ahí: el cambio de forma del `new Request` no puede
      // haberse comido el POST.
      expect(await reenviada.text()).toContain("sonda@example.com");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("un GET se reenvía sin cuerpo y no lanza", async () => {
    // `body` en un GET lanza en el constructor de Request, así que la rama
    // que lo excluye es funcional y no cosmética.
    const fetchMock = vi.fn(async () => new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const res = await worker.fetch(
        new Request("https://api.nulldec.com/rest/v1/decoys", {
          method: "GET",
          headers: { "cf-connecting-ip": "203.0.113.9" },
        }),
        CON_SECRETO,
      );
      expect(res.status).toBe(200);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
