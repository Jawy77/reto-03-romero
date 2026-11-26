// Normalización de texto, NIT, montos y fechas. Funciones puras.

/** "900.555.111-2" → "900555111": sin puntos y sin dígito de verificación. */
export function normalizarNit(nit: string): string {
  const [base] = nit.split("-")
  return (base ?? "").replace(/\D/g, "")
}

/** Minúsculas, sin tildes ni puntuación: para comparar nombres de proveedor. */
export function normalizarNombre(nombre: string): string {
  return nombre
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
}

/** "COP 11.400.000" → 11400000. Formato colombiano: punto de miles, coma decimal. */
export function parseMonto(texto: string): number | null {
  const coincidencia = texto.match(/\d[\d.,]*/)
  if (!coincidencia) return null
  const numero = Number(coincidencia[0].replace(/\./g, "").replace(",", "."))
  return Number.isFinite(numero) ? numero : null
}

/** Día calendario de una fecha ISO, en la zona horaria en que fue escrita. */
export function dia(fechaIso: string): string {
  return fechaIso.slice(0, 10)
}

export function sumarDias(fecha: string, dias: number): string {
  const d = new Date(`${dia(fecha)}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + dias)
  return d.toISOString().slice(0, 10)
}

export function formatoMonto(valor: number, moneda: string): string {
  return `${moneda} ${valor.toLocaleString("es-CO")}`
}

/** Texto breve de SAP: máximo 40 caracteres, sin cortar a mitad de palabra si se puede. */
export function textoBreve(descripcion: string, maximo = 40): string {
  const limpio = descripcion.replace(/\s+/g, " ").trim()
  if (limpio.length <= maximo) return limpio
  const corte = limpio.slice(0, maximo)
  const ultimoEspacio = corte.lastIndexOf(" ")
  return (ultimoEspacio > maximo * 0.6 ? corte.slice(0, ultimoEspacio) : corte).trim()
}
