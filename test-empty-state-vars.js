// test-empty-state-vars.js — v1.0.253
//
// payments.html built its empty-state row from `!!(q || fc || fs || …)`, but the
// customer filter in that function is `fcId` — `fc` had never existed there. The
// reference threw ReferenceError on the ONE path that reaches it: a filter that matches
// no payments. The table then rendered nothing at all instead of "ไม่พบรายการที่ตรงกับ
// ตัวกรอง" with its ล้างตัวกรอง link, so the screen looked broken exactly when the user
// most needed the hint. It survived because every other path skips that branch.
//
// A `const` rename is easy to miss in a branch nobody exercises, and this empty-state
// block is copy-pasted across pages. So: for every Utils.emptyTableRow call, check that
// each identifier it reads is actually declared in the function that reads it.
//
// Run: node test-empty-state-vars.js

const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const t = (name, cond, shown) => {
  if (cond) { pass++; console.log('  PASS  ' + name + (shown !== undefined ? '  → ' + JSON.stringify(shown) : '')); }
  else { fail++; console.log('  FAIL  ' + name + (shown !== undefined ? '  → ' + JSON.stringify(shown) : '')); }
};
const section = s => console.log('\n' + s);

const PAGES = ['payments.html', 'invoices.html', 'history.html', 'customers.html',
               'pricing.html', 'products.html', 'reports.html', 'returns.html'];

// Walk back from a position to the `function name(` that encloses it, then take that
// function's balanced body. Good enough for this codebase's flat top-level functions.
function enclosingFunction(src, pos) {
  const head = src.lastIndexOf('function ', pos);
  if (head < 0) return null;
  const nameEnd = src.indexOf('(', head);
  const name = src.slice(head + 9, nameEnd).trim();
  let depth = 0, i = src.indexOf('{', nameEnd), end = -1;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  if (end < 0 || end < pos) return null;
  return { name, body: src.slice(head, end) };
}

section('every empty-state flag reads a variable that exists');
{
  let callsChecked = 0;
  const problems = [];

  for (const page of PAGES) {
    let src;
    try { src = fs.readFileSync(path.join(__dirname, page), 'utf8'); } catch (e) { continue; }

    const re = /hasDate:\s*!!\(([^)]*)\)|hasOther:\s*!!\(([^)]*)\)/g;
    let m;
    while ((m = re.exec(src))) {
      const expr = m[1] || m[2];
      const fn = enclosingFunction(src, m.index);
      if (!fn) { problems.push(page + ': could not locate the enclosing function'); continue; }
      callsChecked++;

      // Bare identifiers only. In `f.q` the thing that can be a renamed local is `f`;
      // `q` is a property on it. The lookbehind drops the property side — matching it
      // reported history.html's f.q / f.user as undeclared variables.
      const idents = [...new Set(expr.match(/(?<![.\w$])[A-Za-z_$][A-Za-z0-9_$]*/g) || [])];

      for (const id of idents) {
        const declared = new RegExp('\\b(?:const|let|var)\\s+' + id + '\\b').test(fn.body) ||
                         new RegExp('\\bfunction\\s+' + id + '\\b').test(src) ||
                         new RegExp('^\\s*(?:const|let|var)\\s+' + id + '\\b', 'm').test(src);
        if (!declared) problems.push(page + ' → ' + fn.name + '(): "' + id + '" is never declared');
      }
    }
  }

  t('found the empty-state calls to check', callsChecked >= 4, callsChecked);
  t('no empty-state flag reads an undeclared variable', problems.length === 0, problems);
}

section('the specific regression');
{
  const pay = fs.readFileSync(path.join(__dirname, 'payments.html'), 'utf8');
  t('payments.html declares the customer filter as fcId', /const fcId\s+=/.test(pay));
  t('…and the empty-state row reads fcId', /hasOther: !!\(q \|\| fcId \|\|/.test(pay));
  t('…with no `fc` left in that expression', !/hasOther: !!\(q \|\| fc \|\|/.test(pay));
  // The row filter and the empty-state flag must agree on the variable, or the hint can
  // claim "no filter is set" while a filter is what emptied the table.
  t('the row filter uses the same variable', /if \(fcId && inv\.customerId !== fcId\)/.test(pay));

  const invs = fs.readFileSync(path.join(__dirname, 'invoices.html'), 'utf8');
  t('invoices.html genuinely declares its own fc (not the same bug)', /const fc = document/.test(invs));
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
