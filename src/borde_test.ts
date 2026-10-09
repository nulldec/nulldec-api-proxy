/**
 * Las respuestas que FABRICA el Worker, y el WebSocket de Realtime.
 *
 * Incidente del 2026-10-08: la consola vio un fallo de CORS en
 * `GET /v1/rules/flujos` mientras Supabase registraba un 200 a los 34 s. Lo
 * que el navegador recibió no venía de Supabase, y todo lo que no viene de
 * Supabase tiene que llevar las mismas cabeceras CORS, o la consola no puede
 * leer ni el estado.
 *
 * Contra el código anterior: el fallo de red y la excepción hacían RECHAZAR a
 * `worker.fetch` (en producción, la página 1101 de Cloudflare, sin CORS); el
 * fetch colgado no terminaba nunca; el 429 no llevaba `code`; y el upgrade en
 * `/v1/` perdía el `webSocket` al copiar la respuesta.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import worker, { CORS_HEADERS, UPSTREAM_TIMEOUT_MS, esUpgradeWebSocket, type Env } from "./index";

const env: Env = { SUPABASE_HOST: "example.supabase.co", SUPABASE_ANON_KEY: "anon-key" };

function urlDe(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof Request) return input.url;
  return input.toString();
}

const esRpc = (input: RequestInfo | URL) => urlDe(input).includes("/rest/v1/rpc/rate_limit_check_borde");

/** Las cabeceras que el backend pone en sus respuestas (`_shared/http.ts`). */
function esperarCors(res: Response) {
  for (const [nombre, valor] of Object.entries(CORS_HEADERS)) {
    expect(res.headers.get(nombre), nombre).toBe(valor);
  }
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function callarError() {
  vi.spyOn(console, "error").mockImplementation(() => {});
}

describe("CORS_HEADERS es la copia de corsHeaders del backend", () => {
  it("mismos valores que _shared/http.ts", () => {
    // Si el backend cambia los suyos, este literal se cambia a la vez.
    expect(CORS_HEADERS).toEqual({
      "access-control-allow-origin": "*",
      "access-control-allow-headers":
        "authorization, x-client-info, apikey, content-type, x-api-key, x-admin-secret, if-none-match",
      "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
      "access-control-expose-headers": "etag, allow, retry-after",
    });
  });
});

describe("el 429 del borde", () => {
  it("lleva CORS, retry-after y la forma de error de la API ({error, code, detalle})", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) =>
        esRpc(input) ? new Response("false", { status: 200 }) : new Response("no debería llegar"),
      ),
    );
    const res = await worker.fetch(
      new Request("https://api.nulldec.com/v1/rules/flujos", {
        headers: { "cf-connecting-ip": "203.0.113.9", origin: "https://console.nulldec.com" },
      }),
      env,
    );
    expect(res.status).toBe(429);
    esperarCors(res);
    expect(res.headers.get("retry-after")).toBe("60");
    const cuerpo = await res.json();
    expect(cuerpo.code).toBe("rate_limited");
    expect(cuerpo.detalle).toEqual({ retry_after: 60 });
    expect(typeof cuerpo.error).toBe("string");
  });
});

describe("fallos al reenviar", () => {
  it("si fetch a Supabase lanza, 502 upstream_unavailable con CORS (antes: 1101 sin CORS)", async () => {
    callarError();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        if (esRpc(input)) return new Response("true", { status: 200 });
        throw new TypeError("network connection lost");
      }),
    );
    const res = await worker.fetch(
      new Request("https://api.nulldec.com/v1/rules/flujos", { headers: { "cf-connecting-ip": "203.0.113.9" } }),
      env,
    );
    expect(res.status).toBe(502);
    esperarCors(res);
    expect((await res.json()).code).toBe("upstream_unavailable");
  });

  it("cualquier otra excepción del Worker: 500 internal_error con CORS", async () => {
    callarError();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("ok")));
    const roto = { ...env } as Env;
    Object.defineProperty(roto, "SUPABASE_HOST", {
      get() {
        throw new Error("binding roto");
      },
    });
    const res = await worker.fetch(new Request("https://api.nulldec.com/rest/v1/raw_signals"), roto);
    expect(res.status).toBe(500);
    esperarCors(res);
    expect(await res.json()).toEqual({ error: "error interno", code: "internal_error" });
  });
});

describe("el plazo de Supabase (UPSTREAM_TIMEOUT_MS)", () => {
  it("queda entre el plazo más largo de la consola (90 s) y el idle timeout de Supabase (150 s)", () => {
    expect(UPSTREAM_TIMEOUT_MS).toBeGreaterThan(90_000);
    expect(UPSTREAM_TIMEOUT_MS).toBeLessThan(150_000);
  });

  it("un Supabase colgado acaba en 504 upstream_timeout con CORS, y se aborta la subpetición", async () => {
    callarError();
    vi.useFakeTimers();
    let senal: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        if (esRpc(input)) return Promise.resolve(new Response("true", { status: 200 }));
        senal = (input as Request).signal;
        return new Promise<Response>((_, reject) => {
          senal!.addEventListener("abort", () => reject(senal!.reason));
        });
      }),
    );
    const pendiente = worker.fetch(
      new Request("https://api.nulldec.com/v1/rules/flujos", { headers: { "cf-connecting-ip": "203.0.113.9" } }),
      env,
    );
    await vi.advanceTimersByTimeAsync(UPSTREAM_TIMEOUT_MS - 1);
    expect(senal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const res = await pendiente;
    expect(senal?.aborted).toBe(true);
    expect(res.status).toBe(504);
    esperarCors(res);
    expect(await res.json()).toEqual({
      error: "el servicio no respondió a tiempo",
      code: "upstream_timeout",
      detalle: { timeout_s: UPSTREAM_TIMEOUT_MS / 1000 },
    });
  });

  it("el plazo acaba con las cabeceras: un cuerpo lento (SSE) no se corta", async () => {
    vi.useFakeTimers();
    let senal: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        senal = (input as Request).signal;
        return new Response("ok-upstream", { status: 200 });
      }),
    );
    const res = await worker.fetch(new Request("https://api.nulldec.com/rest/v1/raw_signals"), env);
    await vi.advanceTimersByTimeAsync(UPSTREAM_TIMEOUT_MS * 2);
    expect(senal?.aborted).toBe(false);
    expect(await res.text()).toBe("ok-upstream");
  });
});

describe("WebSocket de Realtime", () => {
  const conSecreto: Env = { ...env, PROXY_SHARED_SECRET: "s3creto" };
  const handshake = (ruta: string) =>
    new Request(`https://api.nulldec.com${ruta}`, {
      headers: {
        upgrade: "websocket",
        connection: "Upgrade",
        "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
        "sec-websocket-version": "13",
        "cf-connecting-ip": "203.0.113.9",
      },
    });

  it("esUpgradeWebSocket no distingue mayúsculas", () => {
    expect(esUpgradeWebSocket(new Request("https://x", { headers: { upgrade: "WebSocket" } }))).toBe(true);
    expect(esUpgradeWebSocket(new Request("https://x"))).toBe(false);
  });

  it("/realtime/v1/websocket se reenvía con Upgrade, apikey y vsn, y se devuelve la Response de Supabase TAL CUAL", async () => {
    // En Workers esa Response es un 101 con `webSocket`; undici no deja crear
    // un 101, así que lo que se comprueba es la identidad: es el mismo objeto,
    // luego el `webSocket` no se ha perdido por el camino.
    const deSupabase = new Response(null, { status: 200 });
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) => deSupabase);
    vi.stubGlobal("fetch", fetchMock);

    const res = await worker.fetch(
      handshake("/realtime/v1/websocket?apikey=anon-publica&vsn=2.0.0"),
      conSecreto,
    );

    expect(res).toBe(deSupabase);
    // Una sola llamada: fuera de /v1/ no hay RPC de límite.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const enviada = fetchMock.mock.calls[0][0] as Request;
    expect(enviada.url).toBe("https://example.supabase.co/realtime/v1/websocket?apikey=anon-publica&vsn=2.0.0");
    expect(enviada.method).toBe("GET");
    expect(enviada.headers.get("upgrade")).toBe("websocket");
    expect(enviada.headers.get("sec-websocket-key")).toBe("dGhlIHNhbXBsZSBub25jZQ==");
    // Las mismas cabeceras que el REST: IP firmada para el límite del backend.
    expect(enviada.headers.get("x-nd-real-ip")).toBe("203.0.113.9");
    expect(enviada.headers.get("x-nd-proxy")).toBe("s3creto");
  });

  it("también en /v1/, donde se anuncia la política: la Response no se copia (perdería el webSocket)", async () => {
    const deSupabase = new Response(null, { status: 200 });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => (esRpc(input) ? new Response("true") : deSupabase)),
    );
    const res = await worker.fetch(handshake("/v1/algo/ws"), env);
    expect(res).toBe(deSupabase);
  });

  it("si el handshake falla, 502 sin cuerpo JSON (un cliente WebSocket no lo leería)", async () => {
    callarError();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("network connection lost");
      }),
    );
    const res = await worker.fetch(handshake("/realtime/v1/websocket?apikey=k&vsn=2.0.0"), env);
    expect(res.status).toBe(502);
    expect(res.headers.get("content-type")).toBeNull();
  });
});
