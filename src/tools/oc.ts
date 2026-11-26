// Herramientas del agente de órdenes de compra. Cada export es una herramienta;
// el modelo la ve como oc_<export>. Son la única fuente de valores que el agente
// puede afirmar, y se pueden importar sin el servidor (ver demo.ts).
//
// Decisión de diseño: `paquete`, `derivados` y `payload` se aceptan como pide el
// contrato, pero la fuente de verdad es siempre el disco. Cada herramienta relee
// y recalcula; lo que mande el modelo solo se contrasta. Así un monto "arreglado"
// por el modelo no puede llegar a SAP.
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { z } from "zod"
import { registrarControl } from "../dominio/control"
import { validar as aplicarControles } from "../dominio/controles"
import { OrdenCompraSchema, PaqueteSchema, type Validacion } from "../dominio/esquemas"
import { archivoEvidencia, construirEvidencia, pdfEvidencia } from "../dominio/evidencia"
import { cargarMaestros, leerPaquete } from "../dominio/lectura"
import { construirOrden, mismaOrden } from "../dominio/payload"
import { SapMock } from "../sap/mock"
import { definir, exito, fallo, type Contexto } from "./tipos"

const argCaso = z.string().describe("Nombre de la carpeta del caso en fixtures/reto-03/solicitudes/, por ejemplo sol-001")

function escribir(ctx: Contexto, caso: string, nombre: string, contenido: string | Uint8Array): string {
  const carpeta = join(ctx.directory, "out", caso)
  mkdirSync(carpeta, { recursive: true })
  writeFileSync(join(carpeta, nombre), contenido)
  return join("out", caso, nombre)
}

function mensajeError(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** Relee el paquete y los maestros y aplica los controles. Base de todas las herramientas. */
function evaluar(ctx: Contexto, caso: string) {
  const leido = leerPaquete(ctx.directory, caso)
  if (!leido.ok) return leido
  const maestros = cargarMaestros(ctx.directory)
  if (!maestros.ok) return maestros
  const validacion: Validacion = aplicarControles(leido.valor.paquete, maestros.valor)
  return { ok: true as const, valor: { ...leido.valor, maestros: maestros.valor, validacion } }
}

export const leer_paquete = definir({
  description:
    "Lee y normaliza el paquete de una solicitud de compra (correo, solicitud, cotización, aprobación y factura si existe). Es siempre el primer paso.",
  args: { caso: argCaso },
  async execute(args, ctx) {
    try {
      const leido = leerPaquete(ctx.directory, args.caso)
      if (!leido.ok) return fallo(leido.error)
      return exito({ ...leido.valor.paquete, faltantes: leido.valor.faltantes })
    } catch (e) {
      return fallo(`No se pudo leer el paquete: ${mensajeError(e)}`)
    }
  },
})

export const validar = definir({
  description:
    "Aplica las reglas de control RC1 a RC10 contra los maestros y devuelve si la solicitud es apta, los bloqueos, las confirmaciones pendientes, los valores derivados y si es retroactiva.",
  args: {
    caso: argCaso,
    paquete: z
      .unknown()
      .optional()
      .describe("Paquete devuelto por oc_leer_paquete. Opcional: la herramienta relee la fuente y solo lo contrasta."),
  },
  async execute(args, ctx) {
    try {
      const evaluado = evaluar(ctx, args.caso)
      if (!evaluado.ok) return fallo(evaluado.error)
      const advertencias: string[] = []
      const suministrado = PaqueteSchema.safeParse(args.paquete)
      if (suministrado.success && JSON.stringify(suministrado.data.solicitud) !== JSON.stringify(evaluado.valor.paquete.solicitud)) {
        advertencias.push("El paquete suministrado difiere de la fuente; se validó la fuente.")
      }
      return exito({ ...evaluado.valor.validacion, advertencias })
    } catch (e) {
      return fallo(`No se pudo validar: ${mensajeError(e)}`)
    }
  },
})

export const construir_payload = definir({
  description:
    "Construye la orden de compra tal como quedaría en SAP y guarda la trazabilidad de cada valor. Solo funciona si la solicitud no tiene bloqueos.",
  args: {
    caso: argCaso,
    paquete: z.unknown().optional().describe("Paquete de oc_leer_paquete. Opcional: se relee de la fuente."),
    derivados: z.unknown().optional().describe("Derivados de oc_validar. Opcional: se recalculan desde los maestros."),
  },
  async execute(args, ctx) {
    try {
      const evaluado = evaluar(ctx, args.caso)
      if (!evaluado.ok) return fallo(evaluado.error)
      const { paquete, maestros, validacion } = evaluado.valor
      if (!validacion.apta) {
        return fallo("La solicitud tiene bloqueos: no se construye la orden.", { codigo: "BLOQUEADA", bloqueos: validacion.bloqueos })
      }
      const evidencia = construirEvidencia(ctx.directory, args.caso)
      if (!evidencia.ok) return fallo(evidencia.error)
      const construida = construirOrden(paquete, validacion, maestros, evidencia.valor.sha256)
      if (!construida.ok) return fallo(construida.error)
      const ruta_trazabilidad = escribir(ctx, args.caso, "trazabilidad.json", JSON.stringify(construida.valor.trazabilidad, null, 2))
      escribir(ctx, args.caso, "payload.json", JSON.stringify(construida.valor.orden, null, 2))
      return exito({
        orden: construida.valor.orden,
        valor_total: paquete.solicitud.valor_total,
        ruta_trazabilidad,
        confirmaciones_pendientes: validacion.confirmaciones,
      })
    } catch (e) {
      return fallo(`No se pudo construir el payload: ${mensajeError(e)}`)
    }
  },
})

export const generar_evidencia = definir({
  description:
    "Genera la evidencia del correo de aprobación del líder (encabezados, cuerpo y huella sha256) en texto y en PDF, para adjuntarla a la orden.",
  args: { caso: argCaso },
  async execute(args, ctx) {
    try {
      const evidencia = construirEvidencia(ctx.directory, args.caso)
      if (!evidencia.ok) return fallo(evidencia.error)
      const ruta = escribir(ctx, args.caso, "aprobacion.txt", archivoEvidencia(evidencia.valor))
      const ruta_pdf = escribir(ctx, args.caso, "aprobacion.pdf", await pdfEvidencia(evidencia.valor))
      return exito({ ruta, ruta_pdf, sha256: evidencia.valor.sha256 })
    } catch (e) {
      return fallo(`No se pudo generar la evidencia: ${mensajeError(e)}`)
    }
  },
})

export const crear = definir({
  description:
    "Crea la orden de compra en SAP. Rechaza solicitudes con bloqueos y exige confirmado=true cuando hay confirmaciones pendientes; confirmado solo puede ser true si la analista lo confirmó en su último mensaje.",
  args: {
    caso: argCaso,
    payload: z
      .unknown()
      .optional()
      .describe("Orden devuelta por oc_construir_payload. Opcional: la herramienta la reconstruye y rechaza cualquier diferencia."),
    confirmado: z
      .boolean()
      .optional()
      .describe("true únicamente si la analista confirmó de forma explícita las confirmaciones pendientes."),
  },
  async execute(args, ctx) {
    let solicitudId = args.caso
    try {
      const evaluado = evaluar(ctx, args.caso)
      if (!evaluado.ok) return fallo(evaluado.error)
      const { paquete, maestros, validacion } = evaluado.valor
      solicitudId = paquete.solicitud.solicitud_id
      const sap = new SapMock(ctx.directory)
      const base = {
        solicitud_id: solicitudId,
        retroactiva: validacion.retroactiva,
        bloqueos: validacion.bloqueos.map((b) => b.codigo),
        confirmaciones: validacion.confirmaciones.map((c) => c.codigo),
      }

      // Idempotencia: la misma solicitud nunca genera una segunda orden.
      const existente = await sap.buscarOrdenPorReferencia(solicitudId)
      if (existente) {
        registrarControl(ctx.directory, { ...base, resultado: "existente", numero_oc: existente.numero_oc })
        return exito({ numero_oc: existente.numero_oc, fecha: existente.fecha, idempotente: true })
      }

      if (!validacion.apta) {
        registrarControl(ctx.directory, { ...base, resultado: "bloqueada", numero_oc: "" })
        return fallo("La solicitud tiene bloqueos de control: no se crea la orden.", { codigo: "BLOQUEADA", bloqueos: validacion.bloqueos })
      }
      if (validacion.confirmaciones.length > 0 && args.confirmado !== true) {
        registrarControl(ctx.directory, { ...base, resultado: "pendiente_confirmacion", numero_oc: "" })
        return fallo("La orden requiere confirmación humana antes de crearse.", {
          codigo: "REQUIERE_CONFIRMACION",
          confirmaciones: validacion.confirmaciones,
        })
      }

      const evidencia = construirEvidencia(ctx.directory, args.caso)
      if (!evidencia.ok) return fallo(evidencia.error)
      const ruta_evidencia = escribir(ctx, args.caso, "aprobacion.txt", archivoEvidencia(evidencia.valor))
      const construida = construirOrden(paquete, validacion, maestros, evidencia.valor.sha256)
      if (!construida.ok) return fallo(construida.error)

      // El payload del modelo solo se contrasta: si no es idéntico al recalculado, se rechaza.
      if (args.payload !== undefined) {
        const suministrado = OrdenCompraSchema.safeParse(args.payload)
        if (!suministrado.success || !mismaOrden(suministrado.data, construida.valor.orden)) {
          return fallo("El payload recibido no coincide con el generado por oc_construir_payload. Vuelve a llamar oc_crear sin el argumento payload.", {
            codigo: "PAYLOAD_ALTERADO",
          })
        }
      }

      // Última verificación contra el sistema de registro, justo antes de escribir.
      const enSap = await sap.consultarProveedor(construida.valor.orden.proveedor.nit)
      if (!enSap || !enSap.activo) {
        registrarControl(ctx.directory, { ...base, resultado: "bloqueada", numero_oc: "", bloqueos: ["PROVEEDOR_NO_DISPONIBLE_EN_SAP"] })
        return fallo("SAP no reconoce al proveedor como activo en este momento.", { codigo: "BLOQUEADA" })
      }

      const orden = {
        ...construida.valor.orden,
        excepciones: construida.valor.orden.excepciones.map((e) => ({ ...e, confirmado_por: `analista (sesión ${ctx.sessionId})` })),
      }
      escribir(ctx, args.caso, "payload.json", JSON.stringify(orden, null, 2))
      const creada = await sap.crearOrden(orden)
      registrarControl(ctx.directory, { ...base, resultado: "creada", numero_oc: creada.numero_oc })
      return exito({ numero_oc: creada.numero_oc, fecha: creada.fecha, idempotente: false, ruta_evidencia, retroactiva: validacion.retroactiva })
    } catch (e) {
      registrarControl(ctx.directory, { solicitud_id: solicitudId, resultado: "error", numero_oc: "", retroactiva: false, bloqueos: [], confirmaciones: [] })
      return fallo(`No se pudo crear la orden: ${mensajeError(e)}`)
    }
  },
})
