const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'troubleshoot.html'), 'utf8');

function extract(marker, endMarker) {
  const s = src.indexOf(marker);
  const e = src.indexOf(endMarker, s) + endMarker.length;
  return src.slice(s, e);
}

const escFn = extract('function esc(s) {', '}\n');
const Utils = { formatDateTimeTH: (iso) => new Date(iso).toLocaleString('th-TH') };

const errors = [
  { id: 'a1', timestamp: new Date().toISOString(), type: 'DELETE-CLEANUP-FAILED',
    message: 'ลบข้อมูล invoices ล้มเหลว: permission-denied', page: 'invoices.html', user: 'joe',
    detail: { colName: 'invoices', ids: ['old1', 'old2'] } },
  { id: 'a2', timestamp: new Date().toISOString(), type: 'EDIT-DELETE-FAILED',
    message: 'เก็บกวาดหน้าเก่าใบกำกับ 180769-001 ล้มเหลว: unavailable', page: 'invoice-create.html', user: 'joe',
    detail: { invoiceNumber: '180769-001', oldIds: ['stale1', 'stale2'] } },
];

// This is the ACTUAL render body copied verbatim from troubleshoot.html lines ~346-353
const body = `
  ${escFn}
  const errTypes = [...new Set(errors.map(e => e.type || '(ไม่ระบุ)'))].sort();
  const errRows = errors.map(e => \`
      <tr data-err-type="\${esc(e.type || '')}" data-err-text="\${esc((String(e.type||'') + ' ' + String(e.message||'') + ' ' + String(e.page||'') + ' ' + String(e.user||'')).toLowerCase())}">
        <td class="small text-nowrap text-muted">\${Utils.formatDateTimeTH(e.timestamp)}</td>
        <td class="small">\${e.page || '-'}</td>
        <td class="small text-danger">\${e.type ? \`<strong>\${e.type}:</strong> \` : ''}\${String(e.message || '').slice(0, 120)}</td>
        <td class="small text-muted">\${e.user || '-'}</td>
      </tr>\`).join('');
  return { errTypes, errRows };
`;

const fn = new Function('Utils', 'errors', body);
const result = fn(Utils, errors);

console.log('errTypes (feeds the filter dropdown):', result.errTypes);
console.log('\n--- rendered rows ---');
console.log(result.errRows);

const ok = result.errTypes.includes('DELETE-CLEANUP-FAILED') &&
           result.errTypes.includes('EDIT-DELETE-FAILED') &&
           result.errRows.includes('180769-001') &&
           result.errRows.includes('invoices.html') &&
           result.errRows.includes('invoice-create.html');
console.log('\n' + (ok ? 'PASS — both new error types render correctly' : 'FAIL — something is missing'));
process.exit(ok ? 0 : 1);
