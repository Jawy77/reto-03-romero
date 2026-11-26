// Reglas de control RC1–RC10 (PRD 7.3): una función por regla. `validar` es una
// función pura: el mismo paquete y los mismos maestros dan siempre la misma
// validación. Cambiar una regla no toca ni el servidor ni el prompt.
import type {
  CentroCosto,
  Derivado,
  EstadoRegla,
  Hallazgo,
  Maestros,
  Paquete,
  Proveedor,
  Regla,
  Solicitud,
  Validacion,
} from "./esquemas"
import { dia, formatoMonto, normalizarNit, normalizarNombre } from "./texto"

const TOLERANCIA_COTIZACION = 0.02 // RC5: 2 %
const TOLERANCIA_ARITMETICA = 1 // RC10: ± 1 unidad monetaria

export type ProveedorResuelto = { proveedor: Proveedor; via: "nit" | "nombre" }
type Aprobador = CentroCosto["aprobadores"][number]

/** Lo que las reglas necesitan saber: el paquete, los maestros y lo ya resuelto contra ellos. */
type Contexto = {
  paquete: Paquete
  maestros: Maestros
  resuelto: ProveedorResuelto | null
  centro: CentroCosto | null
  aprobador: Aprobador | null
}

/** Lo que una regla puede concluir. */
type Veredicto = {
  cumple(regla: Regla, detalle: string): void
  noEvaluable(regla: Regla, detalle: string): void
  bloquear(regla: Regla, codigo: string, mensaje: string, accion_sugerida: string): void
  confirmar(regla: Regla, codigo: string, mensaje: string, accion_sugerida: string): void
  derivar(regla: Regla, campo: string, derivado: Derivado, detalle: string): void
}

/** RC1: por NIT; si la solicitud no trae NIT, por nombre normalizado. */
export function resolverProveedor(solicitud: Solicitud, proveedores: Proveedor[]): ProveedorResuelto | null {
  if (solicitud.proveedor_nit) {
    const nit = normalizarNit(solicitud.proveedor_nit)
    const porNit = proveedores.find((p) => normalizarNit(p.nit) === nit)
    return porNit ? { proveedor: porNit, via: "nit" } : null
  }
  const nombre = normalizarNombre(solicitud.proveedor_nombre)
  const porNombre = proveedores.find((p) => normalizarNombre(p.nombre) === nombre)
  return porNombre ? { proveedor: porNombre, via: "nombre" } : null
}

/** Aprobadores del centro con tope suficiente para el valor: a quién escalar. */
function conTopeSuficiente(centro: CentroCosto, s: Solicitud): string[] {
  return centro.aprobadores.filter((a) => a.tope >= s.valor_total).map((a) => a.email)
}

// ── Las diez reglas ──────────────────────────────────────────────────────────

function rc1Proveedor({ paquete: { solicitud: s }, resuelto }: Contexto, v: Veredicto): void {
  if (!resuelto) {
    const nit = s.proveedor_nit ? ` (NIT ${s.proveedor_nit})` : ""
    v.bloquear("RC1", "PROVEEDOR_INEXISTENTE", `El proveedor "${s.proveedor_nombre}"${nit} no existe en el maestro de proveedores.`, "Solicitar a Compras la creación del proveedor en SAP antes de tramitar la orden.")
  } else if (!resuelto.proveedor.activo) {
    v.bloquear("RC1", "PROVEEDOR_INACTIVO", `El proveedor ${resuelto.proveedor.nombre} (SAP ${resuelto.proveedor.codigo_sap}) está inactivo.`, "Pedir a Compras la reactivación del proveedor o usar un proveedor activo.")
  } else {
    v.cumple("RC1", `Proveedor ${resuelto.proveedor.nombre} (SAP ${resuelto.proveedor.codigo_sap}) activo, hallado por ${resuelto.via}.`)
  }
}

function rc2Aprobacion({ paquete: { solicitud: s, aprobacion }, centro, aprobador }: Contexto, v: Veredicto): void {
  if (!aprobacion) {
    v.bloquear("RC2", "APROBACION_AUSENTE", "El paquete no trae el correo de aprobación del líder.", "Pedir al solicitante que adjunte el correo de aprobación.")
  } else if (!aprobacion.aprobado) {
    v.bloquear("RC2", "APROBACION_SIN_APROBADO", `El correo de ${aprobacion.de} no contiene una aprobación explícita ("Aprobado").`, "Pedir al líder que responda el correo con una aprobación explícita.")
  } else if (!centro) {
    v.noEvaluable("RC2", "No se puede verificar al aprobador: el centro de costo no existe.")
  } else if (!aprobador) {
    const suficientes = conTopeSuficiente(centro, s)
    const accion = suficientes.length
      ? `Solicitar la aprobación a ${suficientes.join(" o ")}, que tiene autoridad y tope suficiente.`
      : `Ningún aprobador de ${s.centro_costo} tiene tope para ${formatoMonto(s.valor_total, s.moneda)}: escalar a la dirección o reimputar el gasto al centro correcto.`
    v.bloquear("RC2", "APROBADOR_SIN_AUTORIDAD", `${aprobacion.de} no es aprobador del centro ${s.centro_costo} (autorizados: ${centro.aprobadores.map((a) => a.email).join(", ")}).`, accion)
  } else {
    v.cumple("RC2", `Aprobado por ${aprobador.email}, aprobador de ${s.centro_costo}.`)
  }
}

function rc3Tope({ paquete: { solicitud: s }, centro, aprobador }: Contexto, v: Veredicto): void {
  if (!aprobador || !centro) {
    v.noEvaluable("RC3", "Sin aprobador válido no hay tope que comparar.")
  } else if (s.valor_total > aprobador.tope) {
    const suficientes = conTopeSuficiente(centro, s)
    const accion = suficientes.length ? `Solicitar la aprobación a ${suficientes.join(" o ")}.` : "Escalar la aprobación a un nivel superior."
    v.bloquear("RC3", "TOPE_EXCEDIDO", `${formatoMonto(s.valor_total, s.moneda)} supera el tope de ${aprobador.email} (${formatoMonto(aprobador.tope, s.moneda)}).`, accion)
  } else {
    v.cumple("RC3", `${formatoMonto(s.valor_total, s.moneda)} ≤ tope de ${formatoMonto(aprobador.tope, s.moneda)}.`)
  }
}

function rc4Subarea({ paquete: { solicitud: s }, centro }: Contexto, v: Veredicto): void {
  if (!centro) {
    v.bloquear("RC4", "CENTRO_COSTO_INEXISTENTE", `El centro de costo ${s.centro_costo} no existe en el maestro.`, "Pedir al solicitante el centro de costo correcto.")
  } else if (!centro.subareas.includes(s.subarea)) {
    v.bloquear("RC4", "SUBAREA_FUERA_DEL_CENTRO", `La subárea "${s.subarea}" no pertenece al centro ${s.centro_costo} (válidas: ${centro.subareas.join(", ")}).`, "Pedir al solicitante que corrija la subárea o el centro de costo.")
  } else {
    v.cumple("RC4", `Subárea "${s.subarea}" pertenece a ${s.centro_costo}.`)
  }
}

function rc5Cotizacion({ paquete: { solicitud: s, cotizacion } }: Contexto, v: Veredicto): void {
  if (!cotizacion) {
    v.confirmar("RC5", "SIN_COTIZACION", "El paquete no trae una cotización legible para contrastar el valor.", "Confirmar que se crea sin cotización o pedirla al solicitante.")
    return
  }
  const desviacion = Math.abs(cotizacion.total - s.valor_total) / s.valor_total
  const porcentaje = `${(desviacion * 100).toFixed(1)} %`
  if (desviacion <= TOLERANCIA_COTIZACION) {
    v.cumple("RC5", `Cotización y solicitud difieren ${porcentaje} (≤ 2 %).`)
    return
  }
  const solicitado = formatoMonto(s.valor_total, s.moneda)
  v.confirmar(
    "RC5",
    "COTIZACION_DIFIERE",
    `La cotización (${formatoMonto(cotizacion.total, cotizacion.moneda)}) difiere de la solicitud (${solicitado}) en ${porcentaje}, sobre el 2 % permitido.`,
    `Confirmar que la orden se crea por el valor de la solicitud (${solicitado}), que es el que aprobó el líder, o devolver para ajustar la solicitud.`,
  )
}

function rc6IndicadorIva({ paquete: { solicitud: s }, maestros, resuelto }: Contexto, v: Veredicto): void {
  if (s.indicador_iva) {
    if (maestros.indicadoresIva.some((i) => i.codigo === s.indicador_iva)) v.cumple("RC6", `Indicador de IVA ${s.indicador_iva} informado en la solicitud.`)
    else v.bloquear("RC6", "INDICADOR_IVA_INEXISTENTE", `El indicador de IVA "${s.indicador_iva}" no existe en el maestro.`, "Pedir al solicitante un indicador de IVA válido.")
  } else if (resuelto) {
    const p = resuelto.proveedor
    v.derivar("RC6", "indicador_iva", { valor: p.indicador_iva_default, fuente: "maestro.proveedores" }, `Indicador de IVA ${p.indicador_iva_default} tomado del proveedor.`)
    v.confirmar("RC6", "IVA_DERIVADO", `La solicitud no informa indicador de IVA; se tomó ${p.indicador_iva_default} del proveedor ${p.nombre}.`, `Confirmar que ${p.indicador_iva_default} es el indicador correcto para esta compra.`)
  } else {
    v.noEvaluable("RC6", "Sin proveedor no hay indicador de IVA que derivar.")
  }
}

function rc7CondicionesPago({ paquete: { solicitud: s }, maestros, resuelto }: Contexto, v: Veredicto): void {
  if (s.condiciones_pago) {
    if (maestros.condicionesPago.some((c) => c.codigo === s.condiciones_pago)) v.cumple("RC7", `Condiciones de pago ${s.condiciones_pago} informadas en la solicitud.`)
    else v.bloquear("RC7", "CONDICION_PAGO_INEXISTENTE", `La condición de pago "${s.condiciones_pago}" no existe en el maestro.`, "Pedir al solicitante una condición de pago válida.")
  } else if (resuelto) {
    const valor = resuelto.proveedor.condiciones_pago_default
    v.derivar("RC7", "condiciones_pago", { valor, fuente: "maestro.proveedores" }, `Condiciones de pago ${valor} tomadas del proveedor.`)
  } else {
    v.noEvaluable("RC7", "Sin proveedor no hay condiciones de pago que derivar.")
  }
}

/** RC8: la factura es anterior a la solicitud, es decir, la compra ya se hizo. */
export function esRetroactiva({ factura, solicitud }: Paquete): boolean {
  return factura !== null && dia(factura.fecha) < dia(solicitud.fecha_solicitud)
}

function rc8Retroactiva({ paquete }: Contexto, v: Veredicto): void {
  const { factura, solicitud: s } = paquete
  if (factura && esRetroactiva(paquete)) {
    v.confirmar("RC8", "OC_RETROACTIVA", `La factura ${factura.numero} (${dia(factura.fecha)}) es anterior a la solicitud (${dia(s.fecha_solicitud)}): la compra ya se hizo.`, "Confirmar la creación retroactiva; quedará marcada en el log de control para medición.")
  } else {
    v.cumple("RC8", factura ? "La factura no es anterior a la solicitud." : "No hay factura previa: flujo normal.")
  }
}

function rc9FechaAprobacion({ paquete: { solicitud: s, aprobacion } }: Contexto, v: Veredicto): void {
  if (!aprobacion) {
    v.noEvaluable("RC9", "Sin aprobación no hay fecha que comparar.")
  } else if (dia(aprobacion.fecha) < dia(s.fecha_solicitud)) {
    v.confirmar("RC9", "APROBACION_ANTERIOR", `La aprobación (${dia(aprobacion.fecha)}) es anterior a la solicitud (${dia(s.fecha_solicitud)}).`, "Confirmar que la aprobación corresponde a esta solicitud.")
  } else {
    v.cumple("RC9", `Aprobación del ${dia(aprobacion.fecha)}, igual o posterior a la solicitud.`)
  }
}

function rc10Aritmetica({ paquete: { solicitud: s } }: Contexto, v: Veredicto): void {
  const calculado = s.cantidad * s.valor_unitario
  if (Math.abs(calculado - s.valor_total) > TOLERANCIA_ARITMETICA) {
    v.bloquear("RC10", "ARITMETICA_INCONSISTENTE", `cantidad × valor unitario = ${formatoMonto(calculado, s.moneda)}, pero el total informado es ${formatoMonto(s.valor_total, s.moneda)}.`, "Devolver la solicitud para que se corrijan cantidad, valor unitario o total.")
  } else {
    v.cumple("RC10", "cantidad × valor unitario coincide con el total.")
  }
}

const REGLAS: Array<(contexto: Contexto, veredicto: Veredicto) => void> = [
  rc1Proveedor,
  rc2Aprobacion,
  rc3Tope,
  rc4Subarea,
  rc5Cotizacion,
  rc6IndicadorIva,
  rc7CondicionesPago,
  rc8Retroactiva,
  rc9FechaAprobacion,
  rc10Aritmetica,
]

// ── Orquestación ─────────────────────────────────────────────────────────────

function resolverContexto(paquete: Paquete, maestros: Maestros): Contexto {
  const { solicitud: s, aprobacion } = paquete
  const centro = maestros.centros.find((c) => c.centro_costo === s.centro_costo) ?? null
  const aprobador =
    centro && aprobacion?.aprobado ? (centro.aprobadores.find((a) => a.email.toLowerCase() === aprobacion.de.toLowerCase()) ?? null) : null
  return { paquete, maestros, resuelto: resolverProveedor(s, maestros.proveedores), centro, aprobador }
}

export function validar(paquete: Paquete, maestros: Maestros): Validacion {
  const bloqueos: Hallazgo[] = []
  const confirmaciones: Hallazgo[] = []
  const derivados: Record<string, Derivado> = {}
  const reglas = new Map<Regla, { regla: Regla; estado: EstadoRegla; detalle: string }>()
  // Si una regla concluye dos cosas (RC6 deriva y pide confirmar), queda la última: la más exigente.
  const anotar = (regla: Regla, estado: EstadoRegla, detalle: string) => reglas.set(regla, { regla, estado, detalle })

  const veredicto: Veredicto = {
    cumple: (regla, detalle) => anotar(regla, "cumple", detalle),
    noEvaluable: (regla, detalle) => anotar(regla, "no_evaluable", detalle),
    bloquear(regla, codigo, mensaje, accion_sugerida) {
      bloqueos.push({ regla, codigo, mensaje, accion_sugerida })
      anotar(regla, "bloqueo", mensaje)
    },
    confirmar(regla, codigo, mensaje, accion_sugerida) {
      confirmaciones.push({ regla, codigo, mensaje, accion_sugerida })
      anotar(regla, "confirmacion", mensaje)
    },
    derivar(regla, campo, derivado, detalle) {
      derivados[campo] = derivado
      anotar(regla, "derivado", detalle)
    },
  }

  const contexto = resolverContexto(paquete, maestros)
  for (const regla of REGLAS) regla(contexto, veredicto)

  return {
    apta: bloqueos.length === 0,
    bloqueos,
    confirmaciones,
    derivados,
    retroactiva: esRetroactiva(paquete),
    reglas: [...reglas.values()],
  }
}
