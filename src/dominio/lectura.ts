// Lectura de fixtures y maestros. Solo lectura; nunca lanza hacia afuera.
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { z } from "zod"
import {
  AprobacionCrudaSchema,
  CentroCostoSchema,
  CondicionPagoSchema,
  CorreoCrudoSchema,
  IndicadorIvaSchema,
  ProveedorSchema,
  SolicitudSchema,
  type Maestros,
  type Paquete,
  type Resultado,
} from "./esquemas"
import { normalizarNit, parseMonto, sumarDias } from "./texto"

const RAIZ_FIXTURES = join("fixtures", "reto-03")

/** El caso es un nombre de carpeta, nunca una ruta: evita salir de fixtures/. */
const CASO_VALIDO = /^[a-z0-9][a-z0-9-]{0,63}$/i

export function rutaCaso(directorio: string, caso: string): Resultado<string> {
  if (!CASO_VALIDO.test(caso)) {
    return { ok: false, error: `Nombre de caso inválido: "${caso}". Usa el nombre de la carpeta, por ejemplo "sol-001".` }
  }
  const ruta = join(directorio, RAIZ_FIXTURES, "solicitudes", caso)
  if (!existsSync(ruta)) {
    return { ok: false, error: `No existe el caso "${caso}" en fixtures/reto-03/solicitudes/.` }
  }
  return { ok: true, valor: ruta }
}

function leerTexto(ruta: string): string | null {
  try {
    return existsSync(ruta) ? readFileSync(ruta, "utf8") : null
  } catch {
    return null
  }
}

function describirErrores(error: z.ZodError): string {
  return error.issues.map((i) => `${i.path.join(".") || "(raíz)"}: ${i.message}`).join("; ")
}

function leerJson<T>(ruta: string, esquema: z.ZodType<T>, nombre: string): Resultado<T | null> {
  const texto = leerTexto(ruta)
  if (texto === null) return { ok: true, valor: null }
  let crudo: unknown
  try {
    crudo = JSON.parse(texto)
  } catch {
    return { ok: false, error: `${nombre} no es un JSON válido.` }
  }
  const validado = esquema.safeParse(crudo)
  if (!validado.success) {
    return { ok: false, error: `${nombre} tiene datos inválidos (${describirErrores(validado.error)}).` }
  }
  return { ok: true, valor: validado.data }
}

// ── Cotización y factura (texto) ─────────────────────────────────────────────

function capturar(texto: string, patron: RegExp): string | null {
  return texto.match(patron)?.[1]?.trim() ?? null
}

export function referenciaCotizacion(texto: string): string | null {
  return capturar(texto, /^COTIZACI[ÓO]N\s+(\S+)/im)
}

function parsearCotizacion(texto: string): Paquete["cotizacion"] {
  const lineaTotal = capturar(texto, /^TOTAL[^:\n]*:\s*(.+)$/im)
  const total = lineaTotal ? parseMonto(lineaTotal) : null
  const proveedor = capturar(texto, /^Proveedor:\s*(.+)$/im)
  if (total === null || proveedor === null) return null // ilegible: se trata como ausente
  const nit = capturar(texto, /^NIT:\s*([\d.\-]+)/im)
  const fecha = capturar(texto, /^Fecha:\s*(\d{4}-\d{2}-\d{2})/im)
  const diasValidez = capturar(texto, /Validez[^:\n]*:\s*(\d+)\s*d[ií]as/i)
  return {
    proveedor,
    nit: nit ? normalizarNit(nit) : null,
    total,
    moneda: lineaTotal?.match(/\b(COP|USD)\b/)?.[1] ?? "COP",
    validez_hasta: fecha && diasValidez ? sumarDias(fecha, Number(diasValidez)) : null,
    texto,
  }
}

function parsearFactura(texto: string): Paquete["factura"] {
  const numero = capturar(texto, /No\.\s*(\S+)/i)
  const fecha = capturar(texto, /Fecha de emisi[óo]n:\s*(\d{4}-\d{2}-\d{2})/i)
  const lineaTotal = capturar(texto, /^TOTAL[^:\n]*:\s*(.+)$/im)
  const total = lineaTotal ? parseMonto(lineaTotal) : null
  if (!numero || !fecha || total === null) return null
  return { numero, fecha, total }
}

/** "Aprobado" cuenta; "No aprobado" o "desaprobado" no. */
export function contieneAprobacion(cuerpo: string): boolean {
  if (/\b(no|sin)\s+(est[áa]\s+|fue\s+|queda\s+)?aprobad/i.test(cuerpo)) return false
  if (/desaprobad|rechazad/i.test(cuerpo)) return false
  return /\baprobad[oa]\b/i.test(cuerpo)
}

// ── Paquete ──────────────────────────────────────────────────────────────────

export type PaqueteLeido = { paquete: Paquete; faltantes: string[] }

export function leerPaquete(directorio: string, caso: string): Resultado<PaqueteLeido> {
  const ruta = rutaCaso(directorio, caso)
  if (!ruta.ok) return ruta

  const solicitud = leerJson(join(ruta.valor, "solicitud.json"), SolicitudSchema, "solicitud.json")
  if (!solicitud.ok) return { ok: false, error: `${solicitud.error} Pide al solicitante que reenvíe el Excel de solicitud corregido.` }
  if (solicitud.valor === null) {
    return { ok: false, error: "Falta solicitud.json: sin la solicitud no se puede procesar. Pide al solicitante que la adjunte." }
  }

  const correo = leerJson(join(ruta.valor, "correo.json"), CorreoCrudoSchema, "correo.json")
  if (!correo.ok) return correo
  if (correo.valor === null) return { ok: false, error: "Falta correo.json: no hay correo de entrada que referenciar." }

  const aprobacion = leerJson(join(ruta.valor, "aprobacion.json"), AprobacionCrudaSchema, "aprobacion.json")
  if (!aprobacion.ok) return aprobacion

  const textoCotizacion = leerTexto(join(ruta.valor, "cotizacion.txt"))
  const textoFactura = leerTexto(join(ruta.valor, "factura.txt"))
  const cotizacion = textoCotizacion ? parsearCotizacion(textoCotizacion) : null
  const factura = textoFactura ? parsearFactura(textoFactura) : null

  const faltantes: string[] = []
  if (!cotizacion) faltantes.push(textoCotizacion ? "cotizacion.txt (ilegible)" : "cotizacion.txt")
  if (!aprobacion.valor) faltantes.push("aprobacion.json")
  if (textoFactura && !factura) faltantes.push("factura.txt (ilegible)")

  const paquete: Paquete = {
    correo: { id: correo.valor.id, de: correo.valor.de, asunto: correo.valor.asunto, fecha: correo.valor.fecha },
    solicitud: solicitud.valor,
    cotizacion,
    aprobacion: aprobacion.valor
      ? {
          de: aprobacion.valor.de,
          fecha: aprobacion.valor.fecha,
          aprobado: contieneAprobacion(aprobacion.valor.cuerpo),
          texto: aprobacion.valor.cuerpo,
        }
      : null,
    factura,
  }
  return { ok: true, valor: { paquete, faltantes } }
}

/** Correo de aprobación tal como llegó, con encabezados, para la evidencia. */
export function leerAprobacionCruda(directorio: string, caso: string) {
  const ruta = rutaCaso(directorio, caso)
  if (!ruta.ok) return ruta
  return leerJson(join(ruta.valor, "aprobacion.json"), AprobacionCrudaSchema, "aprobacion.json")
}

// ── Maestros ─────────────────────────────────────────────────────────────────

export function cargarMaestros(directorio: string): Resultado<Maestros> {
  const base = join(directorio, RAIZ_FIXTURES, "maestros")
  const proveedores = leerJson(join(base, "proveedores.json"), z.array(ProveedorSchema), "proveedores.json")
  const centros = leerJson(join(base, "centros-costo.json"), z.array(CentroCostoSchema), "centros-costo.json")
  const iva = leerJson(join(base, "indicadores-iva.json"), z.array(IndicadorIvaSchema), "indicadores-iva.json")
  const pago = leerJson(join(base, "condiciones-pago.json"), z.array(CondicionPagoSchema), "condiciones-pago.json")
  for (const m of [proveedores, centros, iva, pago]) if (!m.ok) return m
  if (!proveedores.ok || !centros.ok || !iva.ok || !pago.ok) return { ok: false, error: "Maestros ilegibles." }
  if (!proveedores.valor || !centros.valor || !iva.valor || !pago.valor) {
    return { ok: false, error: "Falta al menos un archivo maestro en fixtures/reto-03/maestros/." }
  }
  return {
    ok: true,
    valor: {
      proveedores: proveedores.valor,
      centros: centros.valor,
      indicadoresIva: iva.valor,
      condicionesPago: pago.valor,
    },
  }
}
