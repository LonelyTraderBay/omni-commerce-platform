import path from 'node:path';

import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';

import { neutralizeSpreadsheetFormula } from '../../common/csv/csv-formula-guard';

export type ExportOrderRow = {
  id: string;
  status: string;
  customerName: string | null;
  phoneE164: string | null;
  addressText: string | null;
  paymentMethod: string;
  totalVnd: string;
  createdAt: string;
  confirmedAt: string | null;
  shippedAt: string | null;
  sku: string;
  qty: string;
  title: string;
};

export type ExportFormat = 'csv' | 'xlsx' | 'pdf';

export type ExportFile = {
  buffer: Buffer;
  contentType: string;
  filename: string;
};

export const EXPORT_HEADERS = [
  'Mã đơn',
  'Trạng thái',
  'Tên khách',
  'Số điện thoại',
  'Địa chỉ',
  'Hình thức thanh toán',
  'Tổng tiền (VND)',
  'Ngày tạo',
  'Ngày xác nhận',
  'Ngày giao',
  'Mã SKU',
  'Số lượng',
  'Tên sản phẩm',
] as const;

function toCells(row: ExportOrderRow) {
  return [
    row.id,
    row.status,
    row.customerName ?? '',
    row.phoneE164 ?? '',
    row.addressText ?? '',
    row.paymentMethod,
    row.totalVnd,
    row.createdAt,
    row.confirmedAt ?? '',
    row.shippedAt ?? '',
    row.sku,
    row.qty,
    row.title,
  ];
}

function escapeCsvCell(value: string) {
  // Neutralize first, quote second: the apostrophe has to land *inside* the
  // quotes so the spreadsheet sees it as the cell's first character.
  const safe = neutralizeSpreadsheetFormula(value);
  if (/[",\n\r]/.test(safe)) {
    return `"${safe.replace(/"/g, '""')}"`;
  }
  return safe;
}

export function buildOrdersCsv(rows: ExportOrderRow[]): Buffer {
  const lines = [
    EXPORT_HEADERS.join(','),
    ...rows.map((row) => toCells(row).map(String).map(escapeCsvCell).join(',')),
  ];
  return Buffer.from(`${lines.join('\n')}\n`, 'utf8');
}

/**
 * No formula neutralization here on purpose. ExcelJS only emits a formula cell
 * when handed `{ formula: ... }`; a plain string is written as a shared string
 * (`<c t="s">`, no `<f>` element), so `=cmd|'/c calc'!A0` stays inert text.
 * Prefixing apostrophes would show them literally in the sheet.
 */
export async function buildOrdersXlsx(rows: ExportOrderRow[]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Orders');
  sheet.addRow([...EXPORT_HEADERS]);
  for (const row of rows) {
    sheet.addRow(toCells(row));
  }
  sheet.getRow(1).font = { bold: true };
  const arrayBuffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(arrayBuffer);
}

// Vietnamese customer names, addresses, and product titles need full Unicode
// diacritic coverage (ạ, ệ, ố, ơ, ư, đ, ...) that the PDF base-14 standard
// fonts cannot render (Type1 "Helvetica" only supports single-byte
// StandardEncoding/WinAnsiEncoding). We embed Roboto, a Unicode TrueType
// font with full Vietnamese coverage, licensed under the SIL Open Font
// License 1.1 (see ../../../assets/fonts/OFL.txt).
//
// Roboto was chosen over Noto Sans specifically: pdfkit/fontkit shape four
// lowercase Vietnamese letters (ẹ, ị, ọ, ụ) in Noto Sans as a base glyph plus
// a separate zero-width "dotbelowcomb" mark glyph that carries no Unicode
// code point, which makes pdfkit emit an empty ToUnicode CMap entry for that
// mark (verified by walking fontkit's own glyph run for all 146 precomposed
// Vietnamese letters). The glyph still renders correctly, but copy/paste and
// text-extraction of a very common syllable like "Thị" comes back corrupted.
// Roboto keeps every one of the 146 Vietnamese letters as a single glyph
// with a direct code point, so it round-trips cleanly.
const PDF_FONT_PATH = path.join(__dirname, '../../../assets/fonts/Roboto-Regular.ttf');
const PDF_FONT_SIZE = 9;
const PDF_MARGIN = 50;

function orderRowLine(row: ExportOrderRow) {
  return `${row.id} | ${row.status} | ${row.customerName ?? '-'} | ${row.phoneE164 ?? '-'} | ${row.addressText ?? '-'} | ${row.sku} x${row.qty} ${row.title} | ${row.totalVnd} VND`;
}

export function buildOrdersPdf(rows: ExportOrderRow[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'letter', margin: PDF_MARGIN });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', (error: Error) => reject(error));

    // A row (id | status | customer | phone | address | sku x qty title |
    // total) can run wider than the page for long Vietnamese addresses/names,
    // so we rely on PDFKit's own word-wrap (rather than the previous
    // hand-rolled single unbounded line) to keep every row fully on the
    // page; PDFKit also auto-paginates (adds new pages) when the vertical
    // cursor runs past the bottom margin.
    doc.font(PDF_FONT_PATH).fontSize(PDF_FONT_SIZE);
    doc.text('Xuất đơn hàng');
    doc.moveDown();

    if (rows.length === 0) {
      doc.text('(không có đơn)');
    } else {
      for (const row of rows) {
        doc.text(orderRowLine(row));
      }
    }

    doc.end();
  });
}

export function buildOrdersExport(
  format: ExportFormat,
  rows: ExportOrderRow[],
): Promise<ExportFile> | ExportFile {
  switch (format) {
    case 'csv':
      return {
        buffer: buildOrdersCsv(rows),
        contentType: 'text/csv; charset=utf-8',
        filename: 'orders.csv',
      };
    case 'xlsx':
      return buildOrdersXlsx(rows).then((buffer) => ({
        buffer,
        contentType:
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        filename: 'orders.xlsx',
      }));
    case 'pdf':
      return buildOrdersPdf(rows).then((buffer) => ({
        buffer,
        contentType: 'application/pdf',
        filename: 'orders.pdf',
      }));
  }
}
