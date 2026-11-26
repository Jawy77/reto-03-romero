// Construcción del payload de la OC (PRD 7.4) y de su trazabilidad (HU-3).
// Todo valor sale de la solicitud, la cotización, un maestro o una derivación:
// el modelo de lenguaje nunca aporta valores al payload.
import {
  OrdenCompraSchema,
  type Maestros,
  type OrdenCompra,
  type Paquete,
  type Resultado,
  type Validacion,
} from "./esquemas"
import { resolverProveedor } from "./controles"
import { referenciaCotizacion } from "./lectura"
import { textoBreve } from "./texto"

/** Fuentes admitidas por el PRD (HU-3), más el correo de entrada y el de aprobación. */
export type Fuente = "solicitud" | "cotizacion" | "correo" | "aprobacion" | `maestro.${string}` | "derivado"

export type Trazabilidad = Record<string, { valor: string | number | null; fuente: Fuente; detalle?: string }>

export type OrdenConstruida = { orden: OrdenCompra; trazabilidad: Trazabilidad }

/** La solicitud no trae unidad: horas si la descripción habla de horas; si no, unidades. */
function derivarUnidad(descripcion: string): "UN" | "H" {
  return /\bhoras?\b/i.test(descripcion) ? "H" : "UN"
}

export function construirOrden(
  paquete: Paquete,
  validacion: Validacion,
  maestros: Maestros,
  evidenciaSha256: string,
): Resultado<OrdenConstruida> {
  const { solicitud: s, correo, cotizacion, aprobacion } = paquete
  const resuelto = resolverProveedor(s, maestros.proveedores)
  if (!validacion.apta || !resuelto || !aprobacion) {
    const motivos = validacion.bloqueos.map((b) => `${b.regla}: ${b.mensaje}`).join(" | ")
    return { ok: false, error: `No se construye el payload de una solicitud bloqueada. ${motivos}` }
  }
  const p = resuelto.proveedor
  const condiciones = s.condiciones_pago ?? validacion.derivados.condiciones_pago?.valor
  const iva = s.indicador_iva ?? validacion.derivados.indicador_iva?.valor
  if (!condiciones || !iva) {
    return { ok: false, error: "Faltan condiciones de pago o indicador de IVA y no se pudieron derivar del proveedor." }
  }
  const descripcion = textoBreve(s.descripcion)
  const unidad = derivarUnidad(s.descripcion)
  const cotizacionRef = cotizacion ? referenciaCotizacion(cotizacion.texto) : null

  const candidata: OrdenCompra = {
    referencia: { solicitud_id: s.solicitud_id, correo_id: correo.id, cotizacion_ref: cotizacionRef },
    sociedad: "1000",
    organizacion_compras: "1000",
    proveedor: { codigo_sap: p.codigo_sap, nit: p.nit, nombre: p.nombre },
    moneda: s.moneda,
    condiciones_pago: condiciones,
    aprobador: { email: aprobacion.de, fecha_aprobacion: aprobacion.fecha, evidencia_sha256: evidenciaSha256 },
    posiciones: [
      {
        numero: 10,
        descripcion,
        cantidad: s.cantidad,
        unidad,
        precio_unitario: s.valor_unitario,
        centro_costo: s.centro_costo,
        subarea: s.subarea,
        indicador_iva: iva,
      },
    ],
    excepciones: validacion.confirmaciones.map((c) => ({ codigo: c.codigo, detalle: c.mensaje, confirmado_por: null })),
  }
  const validada = OrdenCompraSchema.safeParse(candidata)
  if (!validada.success) {
    return { ok: false, error: `El payload no cumple el esquema de la OC: ${validada.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}` }
  }

  const trazabilidad: Trazabilidad = {
    "referencia.solicitud_id": { valor: s.solicitud_id, fuente: "solicitud" },
    "referencia.correo_id": { valor: correo.id, fuente: "correo" },
    "referencia.cotizacion_ref": { valor: cotizacionRef, fuente: "cotizacion" },
    sociedad: { valor: "1000", fuente: "derivado", detalle: "constante del PRD 7.4" },
    organizacion_compras: { valor: "1000", fuente: "derivado", detalle: "constante del PRD 7.4" },
    "proveedor.codigo_sap": { valor: p.codigo_sap, fuente: "maestro.proveedores", detalle: `hallado por ${resuelto.via}` },
    "proveedor.nit": { valor: p.nit, fuente: "maestro.proveedores" },
    "proveedor.nombre": { valor: p.nombre, fuente: "maestro.proveedores" },
    moneda: { valor: s.moneda, fuente: "solicitud" },
    condiciones_pago: s.condiciones_pago
      ? { valor: condiciones, fuente: "solicitud", detalle: "validado contra maestro.condiciones-pago" }
      : { valor: condiciones, fuente: "maestro.proveedores", detalle: "condiciones_pago_default: la solicitud no las informa (RC7)" },
    "aprobador.email": { valor: aprobacion.de, fuente: "aprobacion", detalle: "validado contra maestro.centros-costo" },
    "aprobador.fecha_aprobacion": { valor: aprobacion.fecha, fuente: "aprobacion" },
    "aprobador.evidencia_sha256": { valor: evidenciaSha256, fuente: "derivado", detalle: "sha256 de la evidencia de aprobación" },
    "posiciones[0].numero": { valor: 10, fuente: "derivado", detalle: "numeración SAP de 10 en 10" },
    "posiciones[0].descripcion":
      descripcion === s.descripcion
        ? { valor: descripcion, fuente: "solicitud" }
        : { valor: descripcion, fuente: "derivado", detalle: `solicitud.descripcion recortada a 40 caracteres; original: "${s.descripcion}"` },
    "posiciones[0].cantidad": { valor: s.cantidad, fuente: "solicitud" },
    "posiciones[0].unidad": { valor: unidad, fuente: "derivado", detalle: "H si la descripción habla de horas; si no, UN" },
    "posiciones[0].precio_unitario": { valor: s.valor_unitario, fuente: "solicitud" },
    "posiciones[0].centro_costo": { valor: s.centro_costo, fuente: "solicitud", detalle: "validado contra maestro.centros-costo" },
    "posiciones[0].subarea": { valor: s.subarea, fuente: "solicitud", detalle: "validado contra maestro.centros-costo" },
    "posiciones[0].indicador_iva": s.indicador_iva
      ? { valor: iva, fuente: "solicitud", detalle: "validado contra maestro.indicadores-iva" }
      : { valor: iva, fuente: "maestro.proveedores", detalle: "indicador_iva_default: la solicitud no lo informa (RC6, confirmado por la analista)" },
  }
  return { ok: true, valor: { orden: validada.data, trazabilidad } }
}

/** Comparación canónica de dos órdenes, ignorando quién confirmó las excepciones. */
export function mismaOrden(a: OrdenCompra, b: OrdenCompra): boolean {
  const canonica = (o: OrdenCompra) =>
    JSON.stringify(OrdenCompraSchema.parse({ ...o, excepciones: o.excepciones.map((e) => ({ ...e, confirmado_por: null })) }))
  return canonica(a) === canonica(b)
}
