// Proveedor simulado: sigue el mismo guion que el prompt con reglas fijas, sin
// modelo de lenguaje. Sirve para probar el ciclo del agente y el chat sin clave
// y demuestra que cambiar de proveedor no toca el ciclo. No interpreta lenguaje
// libre: solo reconoce un caso ("sol-004") y una confirmación.
import { esConfirmacion, extraerCaso } from "../agent/confirmacion"
import {
  esResultado,
  esTexto,
  esUso,
  type AdaptadorLLM,
  type Bloque,
  type Mensaje,
  type RespuestaLLM,
} from "./adapter"

type Datos = Record<string, unknown>
type Hallazgo = { regla: string; mensaje: string; accion_sugerida: string }
type Turno = { texto: string; resultados: Map<string, { ok: boolean; cuerpo: Datos }>; ultima: string | null; caso: string | null }

const SIN_USO = { entrada: 0, salida: 0 }

function textoUsuario(m: Mensaje): string | null {
  const texto = m.bloques.filter(esTexto).map((b) => b.texto).join(" ")
  return m.rol === "usuario" && texto ? texto : null
}

/** Reúne lo ocurrido desde el último mensaje escrito por la analista. */
function leerTurno(mensajes: Mensaje[]): Turno {
  const inicio = mensajes.findLastIndex((m) => textoUsuario(m) !== null)
  const turno: Turno = { texto: textoUsuario(mensajes[inicio] ?? { rol: "usuario", bloques: [] }) ?? "", resultados: new Map(), ultima: null, caso: null }
  const nombres = new Map<string, string>()
  for (const m of mensajes.slice(inicio + 1)) {
    for (const b of m.bloques) {
      if (esUso(b)) {
        nombres.set(b.id, b.nombre)
        const caso = (b.argumentos as { caso?: unknown }).caso
        if (typeof caso === "string") turno.caso = caso
      }
      if (esResultado(b)) {
        const nombre = nombres.get(b.id) ?? "desconocida"
        turno.resultados.set(nombre, { ok: !b.esError, cuerpo: JSON.parse(b.contenido) as Datos })
        turno.ultima = nombre
      }
    }
  }
  return turno
}

function casoPrevio(mensajes: Mensaje[]): string | null {
  for (const m of mensajes.toReversed()) {
    const texto = textoUsuario(m)
    const caso = texto ? extraerCaso(texto) : null
    if (caso) return caso
  }
  return null
}

function usar(nombre: string, argumentos: Datos): RespuestaLLM {
  const bloque: Bloque = { tipo: "uso_herramienta", id: `sim_${crypto.randomUUID()}`, nombre, argumentos }
  return { bloques: [bloque], motivo: "herramientas", uso: SIN_USO }
}

function decir(texto: string): RespuestaLLM {
  return { bloques: [{ tipo: "texto", texto }], motivo: "fin", uso: SIN_USO }
}

function tablaOrden(orden: Datos, valorTotal: unknown): string {
  const proveedor = orden.proveedor as { nombre: string; codigo_sap: string; nit: string }
  const aprobador = orden.aprobador as { email: string }
  const p = (orden.posiciones as Array<Record<string, string | number>>)[0] ?? {}
  const filas: Array<[string, unknown]> = [
    ["Proveedor", `${proveedor.nombre} (SAP ${proveedor.codigo_sap}, NIT ${proveedor.nit})`],
    ["Descripción", p.descripcion],
    ["Cantidad", `${p.cantidad} ${p.unidad}`],
    ["Precio unitario", Number(p.precio_unitario).toLocaleString("es-CO")],
    ["Valor total", `${orden.moneda} ${Number(valorTotal).toLocaleString("es-CO")}`],
    ["Centro de costo", `${p.centro_costo} / ${p.subarea}`],
    ["Indicador de IVA", p.indicador_iva],
    ["Condiciones de pago", orden.condiciones_pago],
    ["Aprobador", aprobador.email],
  ]
  return ["| Campo | Valor |", "|---|---|", ...filas.map(([campo, valor]) => `| ${campo} | ${String(valor)} |`)].join("\n")
}

function tablaReglas(reglas: Array<{ regla: string; estado: string; detalle: string }>): string {
  return ["| Regla | Estado | Detalle |", "|---|---|---|", ...reglas.map((r) => `| ${r.regla} | ${r.estado} | ${r.detalle} |`)].join("\n")
}

function listar(hallazgos: Hallazgo[]): string {
  return hallazgos.map((h) => `- **${h.regla}** — ${h.mensaje}\n  Acción sugerida: ${h.accion_sugerida}`).join("\n")
}

export class AdaptadorSimulado implements AdaptadorLLM {
  readonly proveedor = "simulado"
  readonly modelo = "reglas-deterministas"

  async enviar(mensajes: Mensaje[]): Promise<RespuestaLLM> {
    const turno = leerTurno(mensajes)
    if (turno.ultima === null) return this.iniciar(turno.texto, mensajes)
    const caso = turno.caso ?? "sol-001"
    const ultimo = turno.resultados.get(turno.ultima)
    if (!ultimo) return decir("No recibí el resultado de la herramienta.")
    const datos = (ultimo.cuerpo.data ?? {}) as Datos

    if (turno.ultima === "oc_crear") return this.cerrar(ultimo, datos)
    if (!ultimo.ok) return decir(`No pude continuar con **${caso}**: ${String(ultimo.cuerpo.error)}`)

    switch (turno.ultima) {
      case "oc_leer_paquete":
        return usar("oc_validar", { caso })
      case "oc_validar":
        if (datos.apta === true) return usar("oc_construir_payload", { caso })
        return decir(
          `**${caso} no se puede crear**: tiene bloqueos de control.\n\n${listar(datos.bloqueos as Hallazgo[])}\n\n${tablaReglas(datos.reglas as Array<{ regla: string; estado: string; detalle: string }>)}`,
        )
      case "oc_construir_payload":
        return usar("oc_generar_evidencia", { caso })
      case "oc_generar_evidencia":
        return this.trasEvidencia(turno, caso)
      default:
        return decir("No sé cómo continuar desde este punto.")
    }
  }

  private iniciar(texto: string, mensajes: Mensaje[]): RespuestaLLM {
    const caso = extraerCaso(texto)
    if (caso) return usar("oc_leer_paquete", { caso })
    const previo = casoPrevio(mensajes)
    if (previo && esConfirmacion(texto)) return usar("oc_crear", { caso: previo, confirmado: true })
    return decir(
      'Estoy en modo simulado (sin modelo de lenguaje). Puedo procesar un caso si me dices su nombre, por ejemplo: **procesa la solicitud "sol-004"**. Los casos disponibles van de sol-001 a sol-006.',
    )
  }

  private trasEvidencia(turno: Turno, caso: string): RespuestaLLM {
    const validacion = (turno.resultados.get("oc_validar")?.cuerpo.data ?? {}) as Datos
    const payload = (turno.resultados.get("oc_construir_payload")?.cuerpo.data ?? {}) as Datos
    const confirmaciones = (validacion.confirmaciones ?? []) as Hallazgo[]
    const pidioRevisar = /no la crees|no crear|no la crear|sin crear|hasta que|antes de crear|mu[eé]strame/i.test(turno.texto)
    if (confirmaciones.length === 0 && !pidioRevisar) return usar("oc_crear", { caso })

    const partes = [
      `**${caso} está lista, pendiente de tu confirmación.** Así quedaría en SAP:`,
      tablaOrden(payload.orden as Datos, payload.valor_total),
      tablaReglas(validacion.reglas as Array<{ regla: string; estado: string; detalle: string }>),
    ]
    if (confirmaciones.length) partes.push(`Requiere confirmación:\n\n${listar(confirmaciones)}`)
    partes.push("¿Confirmas que cree la orden?")
    return decir(partes.join("\n\n"))
  }

  private cerrar(ultimo: { ok: boolean; cuerpo: Datos }, datos: Datos): RespuestaLLM {
    if (ultimo.ok) {
      const repetida = datos.idempotente === true ? " (ya existía: no se creó una segunda)" : ""
      const evidencia = datos.ruta_evidencia ? ` Evidencia de aprobación: \`${String(datos.ruta_evidencia)}\`.` : ""
      const marca = datos.retroactiva === true ? " Quedó marcada como **retroactiva** en el log de control." : ""
      return decir(`**Orden de compra ${String(datos.numero_oc)}**${repetida}.${evidencia}${marca}`)
    }
    if (ultimo.cuerpo.codigo === "REQUIERE_CONFIRMACION") {
      return decir(`La orden requiere tu confirmación antes de crearse:\n\n${listar(ultimo.cuerpo.confirmaciones as Hallazgo[])}\n\n¿Confirmas que la cree?`)
    }
    if (ultimo.cuerpo.codigo === "BLOQUEADA" && Array.isArray(ultimo.cuerpo.bloqueos)) {
      return decir(`**No se creó la orden**: tiene bloqueos de control.\n\n${listar(ultimo.cuerpo.bloqueos as Hallazgo[])}`)
    }
    return decir(`No se creó la orden: ${String(ultimo.cuerpo.error)}`)
  }
}
