// Interpretación del mensaje de la analista: ¿confirmó, o pidió no crear?
// La decisión de aceptar confirmado=true vive en código, no en el prompt.

const NEGATIVA = /^\s*no(?![a-záéíóúñ])|no\s+(la\s+|lo\s+)?(confirmo|crees|cree|crear|procedas|proceder)|cancel|det[eé]n|todav[ií]a no|a[uú]n no/i

const AFIRMATIVA =
  /(^|[^a-záéíóúñ])(confirmo|confirmado|confirmada|confirmar|adelante|procede|proceda|proceder|cr[eé]ala|cr[eé]alo|hazlo|de acuerdo|apruebo|autorizo)(?![a-záéíóúñ])|^\s*(s[ií]|ok|okay|dale|listo|claro)(?![a-záéíóúñ])/i

export function esNegativa(mensaje: string): boolean {
  return NEGATIVA.test(mensaje)
}

/** "Confirmo" autoriza; "no la crees hasta que yo confirme" y "¿qué pasa si confirmo?" no. */
export function esConfirmacion(mensaje: string): boolean {
  const esPregunta = /[?¿]/.test(mensaje)
  return AFIRMATIVA.test(mensaje) && !esNegativa(mensaje) && !esPregunta
}

/** "sol-004", "SOL-2026-004" o "solicitud 4" → "sol-004". */
export function extraerCaso(mensaje: string): string | null {
  const directo = mensaje.match(/sol[-\s]?(?:\d{4}[-\s])?(\d{1,3})(?!\d)/i) ?? mensaje.match(/solicitud\s+(?:n[uú]mero\s+)?(\d{1,3})(?!\d)/i)
  return directo?.[1] ? `sol-${directo[1].padStart(3, "0")}` : null
}
