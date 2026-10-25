'use strict';
/* ═══════════════════════════════════════════════════════════════════════
   صفحة فحص الصلاحيات rls-self-test.html — لا تُتّهم بريئاً

   ما حدث فعلاً (٢٠٢٦-١٠-٢٥): شغّلها المالك بدور programmer فعادت
   «٣ فشل» — واثنان منها ليسا عطباً في قاعدة البيانات بل في الصفحة:

   ١) create_app_user: كانت تقبل INVALID_IDENTIFIER علامةَ نجاح لـ«مدير».
      لكن ٠١٥٩ فتحت البوابة لـprogrammer أيضاً، فصار INVALID_IDENTIFIER
      ردّاً **صحيحاً** له — والصفحة تعدّه فشلاً. الأسوأ: INVALID_IDENTIFIER
      لا يُثبت أن البوابة عُبرت لصالح دور بعينه بلا شك (يكفي أن يتغيّر
      ترتيب الفحوص في الدالة ليصير الردّ نفسه لسبب آخر).
      الحلّ: نداء ثانٍ بمعرّف **موجود** بصيغة صحيحة ⇒ USER_ALREADY_EXISTS.
      وهي تسبق كل إدراج في 0034/0159، فلا مستخدم يُنشأ ولا كلمة سر تتغيّر.

   ٢) admin_delete_sale: ٠٠٣٥ كانت تحصرها على admin، لكن ٠١٠٧ ثم ٠١٣٧
      أعادتا تعريفها بـ`not in ('admin','programmer')`. فـSALE_NOT_FOUND
      للمبرمج = عبر البوابة ثم لم يجد الفاتورة العشوائية — سلوك سليم.
      الصفحة كانت تتوقّعه لـadmin وحده فترميه فشلاً.

   ٣) pos_employees وpos_salary_payments: للمبرمج سياسة all على الأولى
      (0112) وليس على الثانية — عدم اتساق حقيقي نُظهره كـ«ⓘ بالتصميم»
      مع سببه، ولا نصلح سياسة هنا (قرار المالك بعد عودته).

   هذا الاختبار لا يقرأ الـHTML بالعين: يستخرج سكربت الصفحة و**يشغّله**
   على قاعدة وهمية، ثم يقرأ الصفوف التي رسمها. فيُثبت أن:
     • دور programmer وadmin يخرجان بصفر فشل في الحالة السليمة،
     • دور البائع يخرج بصفر فشل أيضاً (البوابة تُرفض فعلاً)،
     • وعندما تفسد البوابة حقاً في القاعدة الوهمية ⇒ تُرصد «✗ فشل».
   ═══════════════════════════════════════════════════════════════════════ */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const PAGE = path.join(__dirname, '..', 'new discussion github', 'apps', 'pos',
  'benamor-sales-system', 'rls-self-test.html');
/* النسخة الجاهزة للرفع. كانت متأخّرة ٦٩ سطراً عن نسخة apps عند HEAD
   (٢٢٢ مقابل ٢٩١) — انحراف صامت لا يراه أي اختبار. نمنعه من الآن. */
const MIRROR = path.join(__dirname, '..', 'new discussion github', 'updated-html-files',
  'benamor-sales-system', 'rls-self-test.html');

const SRC = fs.readFileSync(PAGE, 'utf8');
const SCRIPT = /<script>([\s\S]*?)<\/script>/.exec(SRC);
assert.ok(SCRIPT, 'لم أجد <script> في الصفحة');

/* ── سجلّ صفوف الجدول كما ترسمه الصفحة ─────────────────────────────────── */
function parseRows(rows) {
  return rows.map(tr => {
    const m = /^<td><b>([\s\S]*?)<\/b><\/td><td class="st"><span class="pill (\w+)">/.exec(tr.innerHTML || '');
    return m ? { name: m[1], state: m[2] } : null;
  }).filter(Boolean);
}

/* ── ردود REST/RPC على هيئة Supabase ──────────────────────────────────── */
function ok(data, range) {
  return { ok: true, status: 200, headers: { get: k => (String(k).toLowerCase() === 'content-range' ? range || null : null) }, text: async () => (data === null ? '' : JSON.stringify(data)) };
}
function err(message, status) {
  return { ok: false, status: status || 400, headers: { get: () => null }, text: async () => JSON.stringify({ code: 'P0001', message, details: null, hint: null }) };
}

/* cfg: {role, salaryRows, employees, productPatch, createUserGate, createUserExisting, deleteSale, register} */
function stubFetch(cfg, calls) {
  return async function (url, opts) {
    const o = opts || {};
    const body = o.body ? JSON.parse(o.body) : null;
    const m = /\/rest\/v1\/([^?]+)(\?.*)?$/.exec(url);
    const p = m[1];
    const q = m[2] || '';
    calls.push({ p, q, method: (o.method || 'GET').toUpperCase(), body, prefer: ((o.headers || {}).Prefer || '') });

    if (p === 'rpc/pos_current_role') return ok(cfg.role);
    if (p === 'rpc/pos_current_branch_id') return ok('11111111-1111-1111-1111-111111111111');

    if (p === 'rpc/create_app_user') {
      if (!body || body.p_identifier === '!!') return err(cfg.createUserGate);
      return err(cfg.createUserExisting);
    }
    if (p === 'rpc/admin_delete_sale') return err(cfg.deleteSale);

    if (p === 'pos_salary_payments') {
      const rows = cfg.salaryRows || [];
      return ok(q.includes('count=exact') ? rows.slice(0, 1) : rows, rows.length ? '0-0/' + rows.length : '*/0');
    }
    if (p === 'pos_employees') {
      const n = cfg.employees == null ? 3 : cfg.employees;
      return ok(n ? [{ id: 1 }] : [], n ? '0-0/' + n : '*/0');
    }
    if (p === 'pos_finance_accounts') return ok([{ id: 'a1' }]);
    if (p === 'pos_products') {
      if ((o.method || 'GET') === 'GET') return ok([{ code: 'P1', reorder_point: 5, retail_price: 10 }]);
      /* PATCH: العمود المحظور (reorder_point) له حكم، والمسموح (retail_price) له حكم آخر */
      const blocked = body && Object.prototype.hasOwnProperty.call(body, 'reorder_point');
      const verdict = blocked ? cfg.productPatch : (cfg.retailPatch || 'ok');
      return verdict === 'rejected'
        ? err('permission denied for table pos_products', 403)
        : ok([{ code: 'P1' }]);
    }
    if (p === 'pos_sales') return ok([]);
    if (p === 'pos_finance_register') return ok(cfg.register === 'rejected' ? [] : [{ id: 'f1' }]);
    if (p === 'pos_product_avg_cost') return ok([{ code: 'P1' }]);
    if (p === 'pos_product_stock_summary') return ok([{ code: 'P1' }]);
    if (p === 'pos_finance_account_balances') return ok([{ id: 'a1' }]);
    return ok([]); /* نسخ احتياطية وغيرها */
  };
}

/* ── تشغيل الصفحة كما يفعلها المتصفح ──────────────────────────────────── */
async function runPage(cfg) {
  const els = new Map();
  const drawn = [];
  const mk = () => ({
    innerHTML: '', textContent: '', disabled: false, style: {},
    classList: { add() {}, remove() {} },
    appendChild(c) { drawn.push(c); }
  });
  const document = {
    getElementById(id) { if (!els.has(id)) els.set(id, mk()); return els.get(id); },
    createElement() { return { innerHTML: '', style: {} }; },
    querySelectorAll() { return []; }
  };
  const store = {
    posAuthSession: JSON.stringify({ access_token: 'tok' }),
    posUser: JSON.stringify({ identifier: 'Owner.Admin' })
  };
  const localStorage = {
    getItem: k => (k in store ? store[k] : null),
    setItem(k, v) { store[k] = v; },
    removeItem(k) { delete store[k]; }
  };
  const calls = [];
  const fetchStub = stubFetch(cfg, calls);
  const cryptoStub = { randomUUID: () => '99999999-9999-4999-8999-999999999999' };

  /* الذيل يفتح منفذاً للدوال والمتغيّرات المحليّة (role دالّة let في نفس النطاق) */
  const trailer = '\n;return {runAll,counts:()=>({passCount,failCount,infoCount,warnCount}),role:()=>role};';
  const factory = new Function('document', 'localStorage', 'fetch', 'crypto', 'navigator', 'window',
    '"use strict";' + SCRIPT[1] + trailer);
  const api = factory(document, localStorage, fetchStub, cryptoStub, { clipboard: null }, {});

  /* init() غير متزامن: نمنحه فرصة قراءة الدور */
  for (let i = 0; i < 10; i++) await new Promise(r => setImmediate(r));
  assert.strictEqual(api.role(), cfg.role, 'init لم يضبط الدور من قاعدة البيانات الوهمية');

  drawn.length = 0;
  await api.runAll();
  return { rows: parseRows(drawn), counts: api.counts(), calls, summary: els.get('summary') };
}

const states = r => r.rows.map(x => x.state);
const find = (r, part) => r.rows.filter(x => x.name.includes(part));
const nameOf = r => r.rows.map(x => x.name);

const PROGRAMMER_OK = {
  role: 'programmer',
  salaryRows: [],                                  /* محجوبة عن المبرمج فعلاً */
  employees: 3,
  productPatch: 'ok',
  createUserGate: 'INVALID_IDENTIFIER (حروف إنجليزية وأرقام فقط، 2-40)',
  createUserExisting: 'USER_ALREADY_EXISTS: owner.admin@bag.com',
  deleteSale: 'SALE_NOT_FOUND',
  register: 'ok'
};

/* ═══ ١) الدولة السليمة: لا فشل لأي دور مخوّل ═══════════════════════════ */
test('programmer — لا «فشل» إطلاقاً في الحالة السليمة', async () => {
  const r = await runPage(PROGRAMMER_OK);
  assert.strictEqual(r.counts.failCount, 0, 'صفوف حمراء: ' + JSON.stringify(r.rows.filter(x => x.state === 'bad')));
  assert.strictEqual(r.counts.warnCount, 1, 'تنبيه واحد فقط (حذف REST الذي لا يُختبر هنا)');
});

test('programmer — create_app_user يُثبت عبور البوابة بمعرّف موجود', async () => {
  const r = await runPage(PROGRAMMER_OK);
  const row = find(r, 'create_app_user (دور مخوّل)');
  assert.strictEqual(row.length, 1, 'المتوقّع صف واحد للدور المخوّل');
  assert.strictEqual(row[0].state, 'ok');
  /* النداء الثاني استُخدم بمعرّف الجلسة نفسه لا بـ'!!' */
  const create = r.calls.filter(c => c.p === 'rpc/create_app_user');
  assert.strictEqual(create.length, 2, 'نداءان: ' + create.map(c => JSON.stringify(c.body)).join(' | '));
  assert.strictEqual(create[0].body.p_identifier, '!!');
  assert.strictEqual(create[1].body.p_identifier, 'owner.admin', 'المعرّف الحقيقي للجلسة بعد التصغير');
  assert.ok(create[1].body.p_code.length >= 6, 'الكود لا يسبق فحص الوجود أصلاً، لكن نبقيه صالحاً');
  /* ولا مستخدم أُنشئ: كل الردود أخطاء */
  assert.ok(create.every(c => c.method === 'POST'));
});

test('programmer — admin_delete_sale: SALE_NOT_FOUND يعني عبور البوابة', async () => {
  const r = await runPage(PROGRAMMER_OK);
  const row = find(r, 'admin_delete_sale (صلاحية إدارية');
  assert.strictEqual(row.length, 1);
  assert.strictEqual(row[0].state, 'ok');
  /* قبل التعديل كان يُتوقّع SALE_NOT_FOUND لـadmin وحده فيسقط هنا */
  assert.ok(nameOf(r).some(n => n.includes('دور محجوب')) === false, 'لا صف «دور محجوب» لدور مخوّل');
});

test('programmer — المرتبات والموظفون: حقيقتان موصوفتان لا اتّهام', async () => {
  const r = await runPage(PROGRAMMER_OK);
  const sal = find(r, 'pos_salary_payments');
  const emp = find(r, 'pos_employees');
  assert.strictEqual(sal.length, 1); assert.strictEqual(sal[0].state, 'info');
  assert.match(sal[0].name, /programmer/);
  assert.strictEqual(emp.length, 1); assert.strictEqual(emp[0].state, 'info');
  assert.match(emp[0].name, /programmer/);
});

test('admin — لا «فشل» والمرتبات مقروءة بالكامل', async () => {
  const r = await runPage({
    role: 'admin', salaryRows: [{ id: 's1' }, { id: 's2' }], employees: 4,
    productPatch: 'ok',
    createUserGate: 'INVALID_IDENTIFIER (حروف إنجليزية وأرقام فقط، 2-40)',
    createUserExisting: 'USER_ALREADY_EXISTS: owner.admin@bag.com',
    deleteSale: 'SALE_NOT_FOUND', register: 'ok'
  });
  assert.strictEqual(r.counts.failCount, 0, JSON.stringify(r.rows.filter(x => x.state === 'bad')));
  const sal = find(r, 'pos_salary_payments');
  assert.strictEqual(sal.length, 1, JSON.stringify(r.rows));
  assert.strictEqual(sal[0].state, 'info');
  assert.ok(!sal[0].name.includes('programmer'), 'صفّ المدير ليس صفّ المبرمج');
  /* مدير: يُسأل عن العدد (count=exact) لأنه يقرأ الجدول فعلاً */
  assert.ok(r.calls.some(c => c.p === 'pos_salary_payments' && c.prefer.includes('count=exact')),
    'يُسأل عن الإجمالي عبر ترويسة Prefer: count=exact');
});

test('seller_11 — البوابة تُرفض فعلاً: صفر فشل', async () => {
  const r = await runPage({
    role: 'seller_11', salaryRows: [], employees: 0, productPatch: 'rejected', retailPatch: 'ok',
    createUserGate: 'ONLY_ADMIN_CAN_CREATE_USERS',
    deleteSale: 'ONLY_ADMIN_CAN_DELETE_SALES', register: 'rejected'
  });
  assert.strictEqual(r.counts.failCount, 0, JSON.stringify(r.rows.filter(x => x.state === 'bad')));
  const create = find(r, 'create_app_user (دور محجوب)');
  assert.strictEqual(create.length, 1); assert.strictEqual(create[0].state, 'ok');
  const del = find(r, 'admin_delete_sale (دور محجوب)');
  assert.strictEqual(del.length, 1); assert.strictEqual(del[0].state, 'ok');
  /* لم يُستدعَ create_app_user بمعرّف حقيقي للدور المحجوب (نداء واحد فقط) */
  assert.strictEqual(r.calls.filter(c => c.p === 'rpc/create_app_user').length, 1);
});

/* ═══ ٢) الكشف: عندما تفسد القاعدة حقاً يجب أن تصرخ الصفحة ═════════════ */
test('كشف ١ — بوابة تعبر ثم ترفض: تعارض ٠١٥٩ يُرصد كفشل', async () => {
  const r = await runPage({ ...PROGRAMMER_OK, createUserExisting: 'ONLY_ADMIN_CAN_CREATE_USERS' });
  const bad = r.rows.filter(x => x.state === 'bad');
  assert.strictEqual(bad.length, 1, JSON.stringify(r.rows));
  assert.match(bad[0].name, /create_app_user/);
  assert.ok(r.counts.failCount >= 1);
});

test('كشف ٢ — admin_delete_sale يرفض دوراً مخوّلاً: يُرصد كفشل', async () => {
  const r = await runPage({ ...PROGRAMMER_OK, deleteSale: 'ONLY_ADMIN_CAN_DELETE_SALES' });
  const bad = r.rows.filter(x => x.state === 'bad');
  assert.strictEqual(bad.length, 1, JSON.stringify(r.rows));
  assert.match(bad[0].name, /admin_delete_sale/);
});

test('كشف ٣ — تسريب المرتبات لدور غير مخوّل: يُرصد كفشل', async () => {
  const r = await runPage({
    role: 'seller_11', salaryRows: [{ id: 's1' }], employees: 0, productPatch: 'rejected', retailPatch: 'ok',
    createUserGate: 'ONLY_ADMIN_CAN_CREATE_USERS',
    deleteSale: 'ONLY_ADMIN_CAN_DELETE_SALES', register: 'rejected'
  });
  const bad = r.rows.filter(x => x.state === 'bad' && x.name.includes('pos_salary_payments'));
  assert.strictEqual(bad.length, 1, JSON.stringify(r.rows));
});

test('كشف ٤ — مصدر يكشف مصدراً: معرّف جلسة غير صالح لا يُدّعى نجاحه', async () => {
  const els = new Map(); const drawn = [];
  const mk = () => ({ innerHTML: '', textContent: '', disabled: false, style: {}, classList: { add() {}, remove() {} }, appendChild(c) { drawn.push(c); } });
  const document = { getElementById(id) { if (!els.has(id)) els.set(id, mk()); return els.get(id); }, createElement() { return { innerHTML: '', style: {} }; }, querySelectorAll() { return []; } };
  const store = { posAuthSession: JSON.stringify({ access_token: 't' }), posUser: JSON.stringify({ identifier: 'اسم عربي' }) };
  const localStorage = { getItem: k => (k in store ? store[k] : null), setItem() {}, removeItem() {} };
  const calls = [];
  const factory = new Function('document', 'localStorage', 'fetch', 'crypto', 'navigator', 'window',
    '"use strict";' + SCRIPT[1] + '\n;return {runAll,counts:()=>({passCount,failCount,infoCount,warnCount}),role:()=>role};');
  const api = factory(document, localStorage, stubFetch(PROGRAMMER_OK, calls), { randomUUID: () => 'x' }, {}, {});
  for (let i = 0; i < 10; i++) await new Promise(r => setImmediate(r));
  drawn.length = 0;
  await api.runAll();
  const rows = parseRows(drawn);
  const row = rows.filter(x => x.name.includes('create_app_user (دور مخوّل)'))[0];
  assert.ok(row, JSON.stringify(rows));
  assert.strictEqual(row.state, 'info', 'لا نجاح مدّعى ولا فشل: «بالإنفو» مع السبب');
  /* ولم نرسل معرّفاً عربياً إلى الدالة */
  assert.strictEqual(calls.filter(c => c.p === 'rpc/create_app_user').length, 1);
  assert.strictEqual(api.counts().failCount, 0);
});

/* ═══ ٣) لا رجعة إلى الفحص القديم ═══════════════════════════════════════ */
test('السكربت يخلو من فحص INVALID_IDENTIFIER كعلامة نجاح', () => {
  const s = SCRIPT[1];
  assert.ok(s.includes('USER_ALREADY_EXISTS'), 'يجب أن يعتمد على المستخدم الموجود');
  assert.ok(/adminLike=\(admin\|\|devRole\)/.test(s), 'الدور المكافئ معرّف صراحةً');
  assert.ok(s.includes("role==='programmer'"), 'programmer دور يقيَّم كإداري');
  /* الشرط القديم: النجاح = INVALID_IDENTIFIER لـadmin — ممنوع العودة */
  assert.ok(!/\?\'ok\':\'bad\',\s*msgOf\(r\.data,r\.text\)\+\' — المدير عبر بوابة الدور ثم رفضه فحص الحروف/.test(s));
});

/* ═══ ٤) لا انحراف بين النسختين ═════════════════════════════════════════ */
test('النسختان متطابقتان بايتاً ببايت (apps ≡ updated-html-files)', () => {
  const a = fs.readFileSync(PAGE);
  const b = fs.readFileSync(MIRROR);
  assert.ok(a.equals(b),
    'انحراف بين نسختي الصفحة: apps=' + a.length + ' بايت · mirror=' + b.length + ' بايت');
});
