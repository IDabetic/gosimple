/**
 * Serbian pluralization for user-facing counts.
 *
 * Serbian picks one of three forms by the last digit, with an exception for
 * the teens: 1 greška, 2–4 greške, 5+ grešaka, but 11–14 grešaka because
 * eleven through fourteen behave like "many" regardless of their last digit.
 *
 * Getting this wrong is the clearest possible signal that a tool was
 * translated rather than written, and a compiler that cannot count its own
 * errors in the user's language is not one people trust with their ranking.
 */
export function plural(count: number, one: string, few: string, many: string): string {
  const lastTwo = Math.abs(count) % 100;
  const last = Math.abs(count) % 10;
  if (lastTwo >= 11 && lastTwo <= 14) return many;
  if (last === 1) return one;
  if (last >= 2 && last <= 4) return few;
  return many;
}

export const pluralGreska = (n: number): string => plural(n, 'greška', 'greške', 'grešaka');
export const pluralKategorija = (n: number): string => plural(n, 'kategorija', 'kategorije', 'kategorija');
export const pluralPravilo = (n: number): string => plural(n, 'pravilo', 'pravila', 'pravila');
export const pluralUpozorenje = (n: number): string => plural(n, 'upozorenje', 'upozorenja', 'upozorenja');
export const pluralArtikal = (n: number): string => plural(n, 'artikal', 'artikla', 'artikala');
export const pluralProizvod = (n: number): string => plural(n, 'proizvod', 'proizvoda', 'proizvoda');

/** 1 prekršaj / 2 prekršaja / 5 prekršaja */
export function pluralPrekrsaj(count: number): string {
  return plural(count, 'prekršaj', 'prekršaja', 'prekršaja');
}
