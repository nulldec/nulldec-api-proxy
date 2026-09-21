import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// El único import del Worker desde este fichero. Es lo que permite probar la
// costura entre los dos tramos que firman la IP (ver el describe del final);
// probar cada mitad por separado dejaría pasar el fallo que de verdad
// importa: que la IP del relé no llegue a alimentar `x-nd-real-ip`.
import worker, { cabecerasHaciaSupabase } from "./index.ts";
import {
  CABECERA_IP,
  CABECERA_SECRETO,
  type EntornoRele,
  esIP,
  esIPv4,
  esIPv6,
  igualesEnTiempoConstante,
  ipDelCliente,
  limpiarCabecerasDeRele,
  registrarDiagnostico,
  reiniciarAvisos,
  resolverIpDelCliente,
  SILENCIO_MS,
  sinCabecerasDeRele,
} from "./rele.ts";

const SECRETO = "s3cr3t0-del-rele-de-hetzner-no-es-el-real";
// Anotado como `EntornoRele` y no inferido: sin la anotación, TypeScript
// deduce `{ RELAY_SECRET: string }` (obligatorio) y pasar `{}` —el Worker sin
// secreto, que es justo el caso que hay que probar— deja de compilar. `tsc`
// lo caza aunque vitest no: son dos puertas distintas.
const ENV: EntornoRele = { RELAY_SECRET: SECRETO };

/** Petición de juguete con las cabeceras que se le pasen. */
function pet(headers: Record<string, string>, url = "https://api.nulldec.com/v1/algo"): Request {
  return new Request(url, { headers });
}

describe("ipDelCliente — la matriz de seguridad", () => {
  it("sin cabecera de relé usa la que observó Cloudflare", () => {
    const r = pet({ "cf-connecting-ip": "203.0.113.9" });
    expect(ipDelCliente(r, ENV)).toBe("203.0.113.9");
  });

  it("con secreto correcto usa la IP declarada por el relé", () => {
    const r = pet({
      "cf-connecting-ip": "5.9.10.11", // el VPS del relé
      [CABECERA_IP]: "80.29.28.9",
      [CABECERA_SECRETO]: SECRETO,
    });
    expect(ipDelCliente(r, ENV)).toBe("80.29.28.9");
  });

  // ── Las cuatro formas de falsificar, y su rechazo ──

  it("IP declarada SIN secreto: se ignora", () => {
    const r = pet({ "cf-connecting-ip": "203.0.113.9", [CABECERA_IP]: "1.2.3.4" });
    expect(ipDelCliente(r, ENV)).toBe("203.0.113.9");
  });

  it("IP declarada con secreto EQUIVOCADO: se ignora", () => {
    const r = pet({
      "cf-connecting-ip": "203.0.113.9",
      [CABECERA_IP]: "1.2.3.4",
      [CABECERA_SECRETO]: "no-es-el-secreto",
    });
    expect(ipDelCliente(r, ENV)).toBe("203.0.113.9");
  });

  it("secreto correcto pero prefijo del real: se ignora (nada de comparar por prefijo)", () => {
    const r = pet({
      "cf-connecting-ip": "203.0.113.9",
      [CABECERA_IP]: "1.2.3.4",
      [CABECERA_SECRETO]: SECRETO.slice(0, 10),
    });
    expect(ipDelCliente(r, ENV)).toBe("203.0.113.9");
  });

  it("secreto correcto con basura añadida: se ignora", () => {
    const r = pet({
      "cf-connecting-ip": "203.0.113.9",
      [CABECERA_IP]: "1.2.3.4",
      [CABECERA_SECRETO]: SECRETO + "x",
    });
    expect(ipDelCliente(r, ENV)).toBe("203.0.113.9");
  });

  // ── El estado anterior (y posterior) a la migración ──

  it("sin RELAY_SECRET en el entorno NO se cree la cabecera, aunque venga con secreto", () => {
    const r = pet({
      "cf-connecting-ip": "203.0.113.9",
      [CABECERA_IP]: "1.2.3.4",
      [CABECERA_SECRETO]: SECRETO,
    });
    expect(ipDelCliente(r, {})).toBe("203.0.113.9");
  });

  it("RELAY_SECRET vacío se trata como no configurado", () => {
    const r = pet({
      "cf-connecting-ip": "203.0.113.9",
      [CABECERA_IP]: "1.2.3.4",
      [CABECERA_SECRETO]: "",
    });
    expect(ipDelCliente(r, { RELAY_SECRET: "" })).toBe("203.0.113.9");
  });

  // ── Datos con forma inválida: se degrada, no se rompe ──

  it("secreto correcto pero IP con forma inválida: cae a la de Cloudflare", () => {
    for (const basura of ["no-una-ip", "", "999.1.1.1", "1.2.3", "0x7f.0.0.1", "1.2.3.4.5", "::ggg"]) {
      const r = pet({
        "cf-connecting-ip": "203.0.113.9",
        [CABECERA_IP]: basura,
        [CABECERA_SECRETO]: SECRETO,
      });
      expect(ipDelCliente(r, ENV), `debería rechazar ${JSON.stringify(basura)}`).toBe("203.0.113.9");
    }
  });

  it("una inyección de cabecera en la IP no pasa el validador", () => {
    const r = pet({
      "cf-connecting-ip": "203.0.113.9",
      [CABECERA_IP]: "1.2.3.4, 5.6.7.8",
      [CABECERA_SECRETO]: SECRETO,
    });
    expect(ipDelCliente(r, ENV)).toBe("203.0.113.9");
  });

  it("IPv6 real del relé se acepta", () => {
    const r = pet({
      "cf-connecting-ip": "5.9.10.11",
      [CABECERA_IP]: "2a02:9130:88c1:4d00::42",
      [CABECERA_SECRETO]: SECRETO,
    });
    expect(ipDelCliente(r, ENV)).toBe("2a02:9130:88c1:4d00::42");
  });

  it("devuelve null si no hay ninguna IP, en vez de inventarse una clave compartida", () => {
    expect(ipDelCliente(pet({}), ENV)).toBeNull();
    // Y tampoco se la inventa cuando la declarada no vale.
    const r = pet({ [CABECERA_IP]: "basura", [CABECERA_SECRETO]: SECRETO });
    expect(ipDelCliente(r, ENV)).toBeNull();
  });
});

describe("diagnóstico — el estado intermedio peligroso", () => {
  const diag = (h: Record<string, string>, env: EntornoRele = ENV, url?: string) =>
    resolverIpDelCliente(pet(h, url), env).diagnostico;

  it("clasifica los dos estados sanos", () => {
    expect(diag({ "cf-connecting-ip": "203.0.113.9" })).toBe("sin-rele");
    expect(
      diag({ "cf-connecting-ip": "5.9.10.11", [CABECERA_IP]: "80.29.28.9", [CABECERA_SECRETO]: SECRETO }),
    ).toBe("ok");
  });

  it("distingue las cuatro averías, porque cada una se arregla en un sitio distinto", () => {
    // El Worker no tiene el secreto: falta el paso 5 de la migración.
    expect(diag({ [CABECERA_IP]: "1.2.3.4", [CABECERA_SECRETO]: SECRETO }, {})).toBe("secreto-ausente");

    // El secreto no coincide: los VPS y el Worker han divergido.
    expect(diag({ [CABECERA_IP]: "1.2.3.4", [CABECERA_SECRETO]: "otro" })).toBe("secreto-invalido");

    // Ni siquiera manda secreto.
    expect(diag({ [CABECERA_IP]: "1.2.3.4" })).toBe("secreto-invalido");

    // Se autentica bien pero manda basura: fallo del propio nginx.
    expect(diag({ [CABECERA_IP]: "no-una-ip", [CABECERA_SECRETO]: SECRETO })).toBe("ip-invalida");
  });

  it("detecta la cadena rota por el Host del gemelo, sin saber las IPs de los VPS", () => {
    expect(diag({ "cf-connecting-ip": "1.2.3.4" }, ENV, "https://api-cf.nulldec.com/v1/algo")).toBe(
      "gemelo-sin-cabecera",
    );
  });

  it("NO avisa durante la ventana del paso 5, que es lo que lo hace usable", () => {
    // Secreto ya puesto en el Worker, DNS aún sin mover: el tráfico llega
    // directo al hostname público y sin cabecera. Si esto avisara, serían
    // días de ruido y el aviso acabaría ignorado.
    expect(diag({ "cf-connecting-ip": "1.2.3.4" }, ENV, "https://api.nulldec.com/v1/algo")).toBe("sin-rele");
  });

  it("una URL ilegible no tumba la resolución de la IP", () => {
    const req = { url: "no-es-una-url", headers: new Headers({ "cf-connecting-ip": "203.0.113.9" }) } as Request;
    const r = resolverIpDelCliente(req, ENV);
    expect(r.ip).toBe("203.0.113.9");
    expect(r.diagnostico).toBe("sin-rele");
  });
});

describe("registrarDiagnostico", () => {
  let registro: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    reiniciarAvisos();
    registro = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => registro.mockRestore());

  it("no dice nada cuando todo va bien", () => {
    registrarDiagnostico({ ip: "1.2.3.4", diagnostico: "ok" }, pet({}));
    registrarDiagnostico({ ip: "1.2.3.4", diagnostico: "sin-rele" }, pet({}));
    expect(registro).not.toHaveBeenCalled();
  });

  it("avisa de la avería, con el hostname y qué hacer", () => {
    registrarDiagnostico({ ip: "5.9.10.11", diagnostico: "secreto-ausente" }, pet({}));
    expect(registro).toHaveBeenCalledOnce();
    const msg = String(registro.mock.calls[0][0]);
    expect(msg).toContain("secreto-ausente");
    expect(msg).toContain("api.nulldec.com");
    expect(msg).toContain("RELAY_SECRET");
    expect(msg).toContain("PERDIENDO");
  });

  it("NUNCA escribe el secreto", () => {
    for (const d of ["secreto-ausente", "secreto-invalido", "ip-invalida", "gemelo-sin-cabecera"] as const) {
      reiniciarAvisos();
      registrarDiagnostico({ ip: null, diagnostico: d }, pet({ [CABECERA_SECRETO]: SECRETO }));
    }
    const todo = registro.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");
    expect(todo).not.toContain(SECRETO);
    expect(todo).not.toContain(SECRETO.slice(0, 8));
  });

  it("silencia las repeticiones: mil peticiones rotas son UNA línea, no mil", () => {
    const r = { ip: null, diagnostico: "secreto-ausente" } as const;
    for (let i = 0; i < 1000; i++) registrarDiagnostico(r, pet({}), 1_000_000 + i);
    expect(registro).toHaveBeenCalledOnce();
  });

  it("al pasar el silencio vuelve a avisar, y dice cuántas se calló", () => {
    const r = { ip: null, diagnostico: "secreto-ausente" } as const;
    const t0 = 1_000_000;
    registrarDiagnostico(r, pet({}), t0);
    for (let i = 1; i <= 42; i++) registrarDiagnostico(r, pet({}), t0 + i);
    registrarDiagnostico(r, pet({}), t0 + SILENCIO_MS);

    expect(registro).toHaveBeenCalledTimes(2);
    expect(String(registro.mock.calls[1][0])).toContain("+42 más");
  });

  it("cada tipo de avería tiene su propio silencio: una no tapa a la otra", () => {
    const t0 = 1_000_000;
    registrarDiagnostico({ ip: null, diagnostico: "secreto-ausente" }, pet({}), t0);
    registrarDiagnostico({ ip: null, diagnostico: "ip-invalida" }, pet({}), t0);
    expect(registro).toHaveBeenCalledTimes(2);
  });
});

describe("la unión de los dos tramos — relé → Worker → Supabase", () => {
  // El Worker está EN MEDIO de dos saltos que firman la IP por separado:
  //
  //   usuario → [nginx Hetzner] → [este Worker] → [Edge Function]
  //                RELAY_SECRET      PROXY_SHARED_SECRET
  //
  // Lo que se prueba aquí es la costura: que lo que entra por el primero sale
  // por el segundo. Sin esto, cada mitad puede estar bien y el conjunto mal —
  // que es exactamente lo que pasaría si `cabecerasHaciaSupabase` siguiera
  // alimentándose de `cf-connecting-ip`.
  const envCompleto = { RELAY_SECRET: SECRETO, PROXY_SHARED_SECRET: "secreto-del-tramo-de-supabase" } as never;

  const conRele = () =>
    pet({
      "cf-connecting-ip": "5.9.10.11", // el VPS de Hetzner
      [CABECERA_IP]: "80.29.28.9", // el cliente de verdad
      [CABECERA_SECRETO]: SECRETO,
    });

  it("la IP que llega a Supabase es la del CLIENTE, no la del VPS", () => {
    const req = conRele();
    const ip = resolverIpDelCliente(req, envCompleto).ip ?? "unknown";
    const salida = cabecerasHaciaSupabase(req, envCompleto, ip);

    expect(salida.get("x-nd-real-ip")).toBe("80.29.28.9");
    expect(salida.get("x-nd-real-ip")).not.toBe("5.9.10.11");
  });

  it("sin relé sigue llegando la que observó Cloudflare", () => {
    const req = pet({ "cf-connecting-ip": "203.0.113.9" });
    const ip = resolverIpDelCliente(req, envCompleto).ip ?? "unknown";
    expect(cabecerasHaciaSupabase(req, envCompleto, ip).get("x-nd-real-ip")).toBe("203.0.113.9");
  });

  it("una IP de relé NO firmada no contamina lo que se manda a Supabase", () => {
    const req = pet({ "cf-connecting-ip": "203.0.113.9", [CABECERA_IP]: "1.2.3.4" });
    const ip = resolverIpDelCliente(req, envCompleto).ip ?? "unknown";
    expect(cabecerasHaciaSupabase(req, envCompleto, ip).get("x-nd-real-ip")).toBe("203.0.113.9");
  });

  it("el secreto del relé NO cruza hacia Supabase", () => {
    // Son dos fronteras de confianza distintas: el secreto de Hetzner no
    // tiene nada que hacer en un sistema que no lo usa.
    const salida = cabecerasHaciaSupabase(conRele(), envCompleto, "80.29.28.9");
    expect(salida.get(CABECERA_SECRETO)).toBeNull();
    expect(salida.get(CABECERA_IP)).toBeNull();
    expect([...salida.values()].join("|")).not.toContain(SECRETO);
  });

  // ── Y la de verdad: por el HANDLER, no componiendo a mano ──
  //
  // Las de arriba llaman a `resolverIpDelCliente` y `cabecerasHaciaSupabase`
  // y las encadenan ELLAS. Eso prueba las dos piezas, no el cableado: se
  // comprobó cambiando en `index.ts` la línea que las une por un
  // `cf-connecting-ip` — la regresión exacta que rompería todo esto — y las
  // 98 pruebas siguieron en verde. Una prueba que encadena por su cuenta lo
  // que el código tiene que encadenar no prueba el código.
  //
  // Ésta entra por `worker.fetch` y mira lo que sale por el cable.
  it("el HANDLER manda a Supabase la IP del cliente, no la del VPS", async () => {
    const env = {
      SUPABASE_HOST: "proyecto.supabase.co",
      SUPABASE_ANON_KEY: "anon",
      RELAY_SECRET: SECRETO,
      PROXY_SHARED_SECRET: "secreto-del-tramo-de-supabase",
    } as never;

    let haciaSupabase: Request | null = null;
    const espia = vi.spyOn(globalThis, "fetch").mockImplementation(async (entrada: never) => {
      const req = entrada as Request;
      // El límite de tasa del borde: se le contesta que sí y se sigue.
      if (req.url.includes("/rpc/")) {
        return new Response("true", { headers: { "content-type": "application/json" } });
      }
      haciaSupabase = req;
      return new Response("ok");
    });

    try {
      await worker.fetch(
        new Request("https://api.nulldec.com/v1/algo", {
          headers: {
            "cf-connecting-ip": "5.9.10.11", // el VPS de Hetzner
            [CABECERA_IP]: "80.29.28.9", // el cliente de verdad
            [CABECERA_SECRETO]: SECRETO,
          },
        }),
        env,
      );
    } finally {
      espia.mockRestore();
    }

    expect(haciaSupabase, "no se llegó a reenviar nada").not.toBeNull();
    expect(haciaSupabase!.headers.get("x-nd-real-ip")).toBe("80.29.28.9");
    // Y el secreto del relé no cruza la frontera.
    expect(haciaSupabase!.headers.get(CABECERA_SECRETO)).toBeNull();
    expect(haciaSupabase!.headers.get(CABECERA_IP)).toBeNull();
  });

  it("y tampoco cruzan si NO validaron: son basura inyectada", () => {
    const req = pet({
      "cf-connecting-ip": "203.0.113.9",
      [CABECERA_IP]: "1.2.3.4",
      [CABECERA_SECRETO]: "secreto-inventado",
    });
    const salida = cabecerasHaciaSupabase(req, envCompleto, "203.0.113.9");
    expect(salida.get(CABECERA_IP)).toBeNull();
    expect(salida.get(CABECERA_SECRETO)).toBeNull();
  });
});

describe("igualesEnTiempoConstante", () => {
  it("acepta lo idéntico y rechaza lo demás", () => {
    expect(igualesEnTiempoConstante("abc", "abc")).toBe(true);
    expect(igualesEnTiempoConstante("", "")).toBe(true);
    expect(igualesEnTiempoConstante("abc", "abd")).toBe(false);
    expect(igualesEnTiempoConstante("abc", "ab")).toBe(false);
    expect(igualesEnTiempoConstante("ab", "abc")).toBe(false);
    expect(igualesEnTiempoConstante("abc", "")).toBe(false);
  });

  it("compara bytes, no unidades de código: dos cadenas distintas con la misma longitud UTF-16 no colisionan", () => {
    expect(igualesEnTiempoConstante("é", "e")).toBe(false);
    expect(igualesEnTiempoConstante("ñ", "ñ")).toBe(true);
  });
});

describe("esIPv4", () => {
  it("acepta las válidas", () => {
    for (const v of ["0.0.0.0", "1.2.3.4", "255.255.255.255", "203.0.113.9"]) {
      expect(esIPv4(v), v).toBe(true);
    }
  });

  it("rechaza las inválidas", () => {
    for (const v of ["256.1.1.1", "1.2.3", "1.2.3.4.5", "1.2.3.", ".1.2.3", "a.b.c.d", "", " 1.2.3.4"]) {
      expect(esIPv4(v), v).toBe(false);
    }
  });

  it("rechaza los ceros a la izquierda, que se leen como octal en algunos sistemas", () => {
    // "010.1.1.1" es 8.1.1.1 para quien lo lea como octal y 10.1.1.1 para
    // quien no. Una IP que significa dos cosas no vale para atribuir.
    expect(esIPv4("010.1.1.1")).toBe(false);
    expect(esIPv4("1.2.3.04")).toBe(false);
    // Pero un cero solo sí es un cero.
    expect(esIPv4("0.0.0.0")).toBe(true);
  });
});

describe("esIPv6", () => {
  it("acepta la forma completa, la abreviada y la mixta con IPv4", () => {
    for (const v of [
      "2001:0db8:0000:0000:0000:ff00:0042:8329",
      "2001:db8::1",
      "::1",
      "::",
      "::ffff:203.0.113.9",
      "2a02:9130:88c1:4d00::42",
    ]) {
      expect(esIPv6(v), v).toBe(true);
    }
  });

  it("rechaza las inválidas", () => {
    for (const v of [
      "1::2::3",        // dos abreviaturas
      "12345::1",       // grupo de 5 dígitos
      "2001:db8:::1",   // tres dos-puntos
      ":1:2:3:4:5:6:7", // dos-puntos inicial suelto
      "1.2.3.4",        // eso es IPv4, no IPv6
      "fe80::1%eth0",   // el identificador de zona no es parte de la dirección
      "",
      "::gggg",
      "2001:db8:0:0:0:ff00:42:8329:1234", // 9 grupos
    ]) {
      expect(esIPv6(v), v).toBe(false);
    }
  });

  it("exige los 8 grupos exactos cuando no hay abreviatura", () => {
    expect(esIPv6("2001:db8:0:0:0:ff00:42:8329")).toBe(true);
    expect(esIPv6("2001:db8:0:0:0:ff00:42")).toBe(false);
  });

  it("la cola IPv4 cuenta como dos grupos", () => {
    expect(esIPv6("0:0:0:0:0:ffff:203.0.113.9")).toBe(true);
    // Siete grupos más la cola serían nueve: demasiado.
    expect(esIPv6("0:0:0:0:0:ffff:1:203.0.113.9")).toBe(false);
    // Y una cola que no es una IPv4 válida invalida el conjunto.
    expect(esIPv6("::ffff:999.0.113.9")).toBe(false);
  });
});

describe("esIP", () => {
  it("acepta las dos familias", () => {
    expect(esIP("203.0.113.9")).toBe(true);
    expect(esIP("::1")).toBe(true);
    expect(esIP("cualquier-cosa")).toBe(false);
  });
});

describe("limpieza de cabeceras — la fuga del secreto", () => {
  it("limpiarCabecerasDeRele borra las dos", () => {
    const h = new Headers({
      authorization: "Bearer algo",
      [CABECERA_IP]: "1.2.3.4",
      [CABECERA_SECRETO]: SECRETO,
    });
    limpiarCabecerasDeRele(h);
    expect(h.get(CABECERA_IP)).toBeNull();
    expect(h.get(CABECERA_SECRETO)).toBeNull();
    // Y no se lleva por delante nada más.
    expect(h.get("authorization")).toBe("Bearer algo");
  });

  it("sinCabecerasDeRele las quita del volcado plano, en cualquier caja", () => {
    const limpio = sinCabecerasDeRele({
      "user-agent": "curl/8",
      [CABECERA_IP]: "1.2.3.4",
      "X-ND-Relay": SECRETO, // mayúsculas: se quita igual
    });
    expect(limpio).toEqual({ "user-agent": "curl/8" });
  });

  it("el secreto no sobrevive a un volcado de cabeceras, que es como acabaría en raw_signals", () => {
    const req = pet({
      "user-agent": "curl/8",
      [CABECERA_IP]: "80.29.28.9",
      [CABECERA_SECRETO]: SECRETO,
    });
    const volcado = sinCabecerasDeRele(Object.fromEntries(req.headers));
    expect(JSON.stringify(volcado)).not.toContain(SECRETO);
    expect(JSON.stringify(volcado)).not.toContain("80.29.28.9");
  });
});
