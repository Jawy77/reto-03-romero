// Esquemas zod del dominio. Son la única definición de forma de los datos:
// los tipos TypeScript se infieren de aquí, no se escriben aparte.
import { z } from "zod"

const fechaIso = z.string().regex(/^\d{4}-\d{2}-\d{2}/, "se esperaba una fecha ISO (AAAA-MM-DD)")

// ── Entradas (fixtures) ──────────────────────────────────────────────────────

export const SolicitudSchema = z.object({
  solicitud_id: z.string().min(1),
  solicitante: z.string().min(1),
  proveedor_nombre: z.string().min(1),
  proveedor_nit: z.string().min(1).optional(),
  descripcion: z.string().min(1),
  centro_costo: z.string().min(1),
  subarea: z.string().min(1),
  cantidad: z.number().positive(),
  valor_unitario: z.number().nonnegative(),
  valor_total: z.number().positive(),
  moneda: z.enum(["COP", "USD"]),
  indicador_iva: z.string().min(1).optional(),
  condiciones_pago: z.string().min(1).optional(),
  fecha_solicitud: fechaIso,
})

export const CorreoCrudoSchema = z.object({
  id: z.string().min(1),
  de: z.string().min(1),
  asunto: z.string(),
  fecha: fechaIso,
})

export const AprobacionCrudaSchema = z.object({
  de: z.string().min(1),
  para: z.string().optional(),
  fecha: fechaIso,
  asunto: z.string().optional(),
  cuerpo: z.string(),
})

// ── Paquete normalizado (PRD 7.2) ────────────────────────────────────────────

export const PaqueteSchema = z.object({
  correo: z.object({ id: z.string(), de: z.string(), asunto: z.string(), fecha: z.string() }),
  solicitud: SolicitudSchema,
  cotizacion: z
    .object({
      proveedor: z.string(),
      nit: z.string().nullable(),
      total: z.number(),
      moneda: z.string(),
      validez_hasta: z.string().nullable(),
      texto: z.string(),
    })
    .nullable(),
  aprobacion: z
    .object({ de: z.string(), fecha: z.string(), aprobado: z.boolean(), texto: z.string() })
    .nullable(),
  factura: z.object({ numero: z.string(), fecha: z.string(), total: z.number() }).nullable(),
})

// ── Maestros (PRD 7.1) ───────────────────────────────────────────────────────

export const ProveedorSchema = z.object({
  codigo_sap: z.string(),
  nit: z.string(),
  nombre: z.string(),
  condiciones_pago_default: z.string(),
  indicador_iva_default: z.string(),
  activo: z.boolean(),
})

export const CentroCostoSchema = z.object({
  centro_costo: z.string(),
  nombre: z.string().optional(),
  subareas: z.array(z.string()),
  aprobadores: z.array(
    z.object({ email: z.string(), nombre: z.string().optional(), tope: z.number() }),
  ),
})

export const IndicadorIvaSchema = z.object({
  codigo: z.string(),
  descripcion: z.string(),
  tasa: z.number(),
})

export const CondicionPagoSchema = z.object({
  codigo: z.string(),
  descripcion: z.string(),
  dias: z.number(),
})

// ── Orden de compra (PRD 7.4) ────────────────────────────────────────────────

export const OrdenCompraSchema = z.object({
  referencia: z.object({
    solicitud_id: z.string(),
    correo_id: z.string(),
    cotizacion_ref: z.string().nullable(),
  }),
  sociedad: z.literal("1000"),
  organizacion_compras: z.literal("1000"),
  proveedor: z.object({ codigo_sap: z.string(), nit: z.string(), nombre: z.string() }),
  moneda: z.enum(["COP", "USD"]),
  condiciones_pago: z.string(),
  aprobador: z.object({
    email: z.string(),
    fecha_aprobacion: z.string(),
    evidencia_sha256: z.string().length(64),
  }),
  posiciones: z
    .array(
      z.object({
        numero: z.number().int().positive(),
        descripcion: z.string().min(1).max(40), // límite SAP del texto breve
        cantidad: z.number().positive(),
        unidad: z.enum(["UN", "H", "MES"]),
        precio_unitario: z.number().nonnegative(),
        centro_costo: z.string(),
        subarea: z.string(),
        indicador_iva: z.string(),
      }),
    )
    .min(1),
  excepciones: z.array(
    z.object({ codigo: z.string(), detalle: z.string(), confirmado_por: z.string().nullable() }),
  ),
})

// ── Tipos inferidos ──────────────────────────────────────────────────────────

export type Solicitud = z.infer<typeof SolicitudSchema>
export type Paquete = z.infer<typeof PaqueteSchema>
export type Proveedor = z.infer<typeof ProveedorSchema>
export type CentroCosto = z.infer<typeof CentroCostoSchema>
export type IndicadorIva = z.infer<typeof IndicadorIvaSchema>
export type CondicionPago = z.infer<typeof CondicionPagoSchema>
export type OrdenCompra = z.infer<typeof OrdenCompraSchema>

export type Maestros = {
  proveedores: Proveedor[]
  centros: CentroCosto[]
  indicadoresIva: IndicadorIva[]
  condicionesPago: CondicionPago[]
}

export type Regla = "RC1" | "RC2" | "RC3" | "RC4" | "RC5" | "RC6" | "RC7" | "RC8" | "RC9" | "RC10"

/** Un hallazgo de control: por qué se bloquea o por qué se pide confirmación. */
export type Hallazgo = {
  regla: Regla
  codigo: string
  mensaje: string
  accion_sugerida: string
}

export type EstadoRegla = "cumple" | "bloqueo" | "confirmacion" | "derivado" | "no_evaluable"

export type Derivado = { valor: string; fuente: string }

export type Validacion = {
  apta: boolean
  bloqueos: Hallazgo[]
  confirmaciones: Hallazgo[]
  derivados: Record<string, Derivado>
  retroactiva: boolean
  /** Resultado regla por regla, para mostrar qué pasó y qué no. */
  reglas: Array<{ regla: Regla; estado: EstadoRegla; detalle: string }>
}

/** Resultado tipado de operaciones que pueden fallar: nunca se lanza. */
export type Resultado<T> = { ok: true; valor: T } | { ok: false; error: string }
