/**
 * Locale-stable ordering of node, column and probe ids (SPEC 28.5.4). String.prototype.localeCompare
 * builds an ICU collator on its first call in an isolate, about 5 ms of CPU, which pushed cold Workflow
 * steps toward the Free plan's 10 ms. One collator built at module scope moves that cost to Worker start-up
 * (1 s limit). Its default locale and options are those of localeCompare called without arguments, so
 * every order stays as it was.
 */
const COLLATOR = new Intl.Collator();

export function compareIds(a: string, b: string): number {
  return COLLATOR.compare(a, b);
}
