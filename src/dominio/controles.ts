// Reglas de control RC1–RC10 (PRD 7.3). Función pura: mismo paquete y mismos
// maestros dan siempre la misma validación. Aquí vive la lógica de negocio;
// cambiar una regla no toca ni el servidor ni el prompt.
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

export function validar(paquete: Paquete, maestros: Maestros): Validacion {
  const { solicitud: s, cotizacion, aprobacion, factura } = paquete
  const bloqueos: Hallazgo[] = []
  const confirmaciones: Hallazgo[] = []
  const derivados: Record<string, Derivado> = {}
  const reglas: Validacion["reglas"] = []
  const anotar = (regla: Regla, estado: EstadoRegla, detalle: string) => reglas.push({ regla, estado, detalle })
  const bloquear = (h: Hallazgo) => {
    bloqueos.push(h)
    anotar(h.regla, "bloqueo", h.mensaje)
  }
  const confirmar = (h: Hallazgo) => {
    confirmaciones.push(h)
    anotar(h.regla, "confirmacion", h.mensaje)
  }

  // RC1 — proveedor existente y activo
  const resuelto = resolverProveedor(s, maestros.proveedores)
  if (!resuelto) {
    bloquear({
      regla: "RC1",
      codigo: "PROVEEDOR_INEXISTENTE",
      mensaje: `El proveedor "${s.proveedor_nombre}"${s.proveedor_nit ? ` (NIT ${s.proveedor_nit})` : ""} no existe en el maestro de proveedores.`,
      accion_sugerida: "Solicitar a Compras la creación del proveedor en SAP antes de tramitar la orden.",
    })
  } else if (!resuelto.proveedor.activo) {
    bloquear({
      regla: "RC1",
      codigo: "PROVEEDOR_INACTIVO",
      mensaje: `El proveedor ${resuelto.proveedor.nombre} (SAP ${resuelto.proveedor.codigo_sap}) está inactivo.`,
      accion_sugerida: "Pedir a Compras la reactivación del proveedor o usar un proveedor activo.",
    })
  } else {
    anotar("RC1", "cumple", `Proveedor ${resuelto.proveedor.nombre} (SAP ${resuelto.proveedor.codigo_sap}) activo, hallado por ${resuelto.via}.`)
  }
  const proveedor = resuelto?.proveedor ?? null

  // RC4 — la subárea pertenece al centro de costo (se evalúa antes: RC2 y RC3 dependen del centro)
  const centro: CentroCosto | null = maestros.centros.find((c) => c.centro_costo === s.centro_costo) ?? null
  if (!centro) {
    bloquear({
      regla: "RC4",
      codigo: "CENTRO_COSTO_INEXISTENTE",
      mensaje: `El centro de costo ${s.centro_costo} no existe en el maestro.`,
      accion_sugerida: "Pedir al solicitante el centro de costo correcto.",
    })
  } else if (!centro.subareas.includes(s.subarea)) {
    bloquear({
      regla: "RC4",
      codigo: "SUBAREA_FUERA_DEL_CENTRO",
      mensaje: `La subárea "${s.subarea}" no pertenece al centro ${s.centro_costo} (válidas: ${centro.subareas.join(", ")}).`,
      accion_sugerida: "Pedir al solicitante que corrija la subárea o el centro de costo.",
    })
  } else {
    anotar("RC4", "cumple", `Subárea "${s.subarea}" pertenece a ${s.centro_costo}.`)
  }

  // RC2 — aprobación existente, con "Aprobado", de un aprobador del centro
  const conTope = (c: CentroCosto) =>
    c.aprobadores.filter((a) => a.tope >= s.valor_total).map((a) => a.email)
  const aprobador =
    centro && aprobacion
      ? (centro.aprobadores.find((a) => a.email.toLowerCase() === aprobacion.de.toLowerCase()) ?? null)
      : null
  if (!aprobacion) {
    bloquear({
      regla: "RC2",
      codigo: "APROBACION_AUSENTE",
      mensaje: "El paquete no trae el correo de aprobación del líder.",
      accion_sugerida: "Pedir al solicitante que adjunte el correo de aprobación.",
    })
  } else if (!aprobacion.aprobado) {
    bloquear({
      regla: "RC2",
      codigo: "APROBACION_SIN_APROBADO",
      mensaje: `El correo de ${aprobacion.de} no contiene una aprobación explícita ("Aprobado").`,
      accion_sugerida: "Pedir al líder que responda el correo con una aprobación explícita.",
    })
  } else if (!centro) {
    anotar("RC2", "no_evaluable", "No se puede verificar al aprobador: el centro de costo no existe.")
  } else if (!aprobador) {
    const suficientes = conTope(centro)
    bloquear({
      regla: "RC2",
      codigo: "APROBADOR_SIN_AUTORIDAD",
      mensaje: `${aprobacion.de} no es aprobador del centro ${s.centro_costo} (autorizados: ${centro.aprobadores.map((a) => a.email).join(", ")}).`,
      accion_sugerida: suficientes.length
        ? `Solicitar la aprobación a ${suficientes.join(" o ")}, que tiene autoridad y tope suficiente.`
        : `Ningún aprobador de ${s.centro_costo} tiene tope para ${formatoMonto(s.valor_total, s.moneda)}: escalar a la dirección o reimputar el gasto al centro correcto.`,
    })
  } else {
    anotar("RC2", "cumple", `Aprobado por ${aprobador.email}, aprobador de ${s.centro_costo}.`)
  }

  // RC3 — valor dentro del tope del aprobador
  if (!aprobador || !centro) {
    anotar("RC3", "no_evaluable", "Sin aprobador válido no hay tope que comparar.")
  } else if (s.valor_total > aprobador.tope) {
    const suficientes = conTope(centro)
    bloquear({
      regla: "RC3",
      codigo: "TOPE_EXCEDIDO",
      mensaje: `${formatoMonto(s.valor_total, s.moneda)} supera el tope de ${aprobador.email} (${formatoMonto(aprobador.tope, s.moneda)}).`,
      accion_sugerida: suficientes.length
        ? `Solicitar la aprobación a ${suficientes.join(" o ")}.`
        : "Escalar la aprobación a un nivel superior.",
    })
  } else {
    anotar("RC3", "cumple", `${formatoMonto(s.valor_total, s.moneda)} ≤ tope de ${formatoMonto(aprobador.tope, s.moneda)}.`)
  }

  // RC5 — cotización contra solicitud (2 %)
  if (!cotizacion) {
    confirmar({
      regla: "RC5",
      codigo: "SIN_COTIZACION",
      mensaje: "El paquete no trae una cotización legible para contrastar el valor.",
      accion_sugerida: "Confirmar que se crea sin cotización o pedirla al solicitante.",
    })
  } else {
    const desviacion = Math.abs(cotizacion.total - s.valor_total) / s.valor_total
    if (desviacion > TOLERANCIA_COTIZACION) {
      confirmar({
        regla: "RC5",
        codigo: "COTIZACION_DIFIERE",
        mensaje: `La cotización (${formatoMonto(cotizacion.total, cotizacion.moneda)}) difiere de la solicitud (${formatoMonto(s.valor_total, s.moneda)}) en ${(desviacion * 100).toFixed(1)} %, sobre el 2 % permitido.`,
        accion_sugerida: `Confirmar que la orden se crea por el valor de la solicitud (${formatoMonto(s.valor_total, s.moneda)}), que es el que aprobó el líder, o devolver para ajustar la solicitud.`,
      })
    } else {
      anotar("RC5", "cumple", `Cotización y solicitud difieren ${(desviacion * 100).toFixed(1)} % (≤ 2 %).`)
    }
  }

  // RC6 — indicador de IVA: se deriva del proveedor si falta, con confirmación
  if (s.indicador_iva) {
    if (maestros.indicadoresIva.some((i) => i.codigo === s.indicador_iva)) {
      anotar("RC6", "cumple", `Indicador de IVA ${s.indicador_iva} informado en la solicitud.`)
    } else {
      bloquear({
        regla: "RC6",
        codigo: "INDICADOR_IVA_INEXISTENTE",
        mensaje: `El indicador de IVA "${s.indicador_iva}" no existe en el maestro.`,
        accion_sugerida: "Pedir al solicitante un indicador de IVA válido.",
      })
    }
  } else if (proveedor) {
    derivados.indicador_iva = { valor: proveedor.indicador_iva_default, fuente: "maestro.proveedores.indicador_iva_default" }
    confirmar({
      regla: "RC6",
      codigo: "IVA_DERIVADO",
      mensaje: `La solicitud no informa indicador de IVA; se tomó ${proveedor.indicador_iva_default} del proveedor ${proveedor.nombre}.`,
      accion_sugerida: `Confirmar que ${proveedor.indicador_iva_default} es el indicador correcto para esta compra.`,
    })
  } else {
    anotar("RC6", "no_evaluable", "Sin proveedor no hay indicador de IVA que derivar.")
  }

  // RC7 — condiciones de pago: se derivan del proveedor si faltan, solo se informa
  if (s.condiciones_pago) {
    if (maestros.condicionesPago.some((c) => c.codigo === s.condiciones_pago)) {
      anotar("RC7", "cumple", `Condiciones de pago ${s.condiciones_pago} informadas en la solicitud.`)
    } else {
      bloquear({
        regla: "RC7",
        codigo: "CONDICION_PAGO_INEXISTENTE",
        mensaje: `La condición de pago "${s.condiciones_pago}" no existe en el maestro.`,
        accion_sugerida: "Pedir al solicitante una condición de pago válida.",
      })
    }
  } else if (proveedor) {
    derivados.condiciones_pago = { valor: proveedor.condiciones_pago_default, fuente: "maestro.proveedores.condiciones_pago_default" }
    anotar("RC7", "derivado", `Condiciones de pago ${proveedor.condiciones_pago_default} tomadas del proveedor.`)
  } else {
    anotar("RC7", "no_evaluable", "Sin proveedor no hay condiciones de pago que derivar.")
  }

  // RC8 — orden retroactiva: la factura es anterior a la solicitud
  const retroactiva = factura !== null && dia(factura.fecha) < dia(s.fecha_solicitud)
  if (factura && retroactiva) {
    confirmar({
      regla: "RC8",
      codigo: "OC_RETROACTIVA",
      mensaje: `La factura ${factura.numero} (${dia(factura.fecha)}) es anterior a la solicitud (${dia(s.fecha_solicitud)}): la compra ya se hizo.`,
      accion_sugerida: "Confirmar la creación retroactiva; quedará marcada en el log de control para medición.",
    })
  } else {
    anotar("RC8", "cumple", factura ? "La factura no es anterior a la solicitud." : "No hay factura previa: flujo normal.")
  }

  // RC9 — la aprobación no puede ser anterior a la solicitud
  if (!aprobacion) {
    anotar("RC9", "no_evaluable", "Sin aprobación no hay fecha que comparar.")
  } else if (dia(aprobacion.fecha) < dia(s.fecha_solicitud)) {
    confirmar({
      regla: "RC9",
      codigo: "APROBACION_ANTERIOR",
      mensaje: `La aprobación (${dia(aprobacion.fecha)}) es anterior a la solicitud (${dia(s.fecha_solicitud)}).`,
      accion_sugerida: "Confirmar que la aprobación corresponde a esta solicitud.",
    })
  } else {
    anotar("RC9", "cumple", `Aprobación del ${dia(aprobacion.fecha)}, igual o posterior a la solicitud.`)
  }

  // RC10 — aritmética de la solicitud
  const calculado = s.cantidad * s.valor_unitario
  if (Math.abs(calculado - s.valor_total) > TOLERANCIA_ARITMETICA) {
    bloquear({
      regla: "RC10",
      codigo: "ARITMETICA_INCONSISTENTE",
      mensaje: `cantidad × valor unitario = ${formatoMonto(calculado, s.moneda)}, pero el total informado es ${formatoMonto(s.valor_total, s.moneda)}.`,
      accion_sugerida: "Devolver la solicitud para que se corrijan cantidad, valor unitario o total.",
    })
  } else {
    anotar("RC10", "cumple", "cantidad × valor unitario coincide con el total.")
  }

  reglas.sort((a, b) => Number(a.regla.slice(2)) - Number(b.regla.slice(2)))
  return { apta: bloqueos.length === 0, bloqueos, confirmaciones, derivados, retroactiva, reglas }
}
