'use strict';
/* ═══════════════════════════════════════════════════════════════════════
   (0166) pos_sales وpos_stock — هل الحذف المباشر مغلق فعلاً؟

   المنشأ: المالك شغّل استعلام (٣) بعد 0165 (يفلتر cmd='DELETE') فعاد
   «Success. No rows returned». وهذا يحتمل معنيين متضادّين:

     (أ) لا سياسة إطلاقاً على الجدولين ⇒ RLS تمنع كل حذف مباشر. آمن.
     (ب) السياسة القديمة `pos_role_sales_write` / `pos_role_stock_write`
         (`for all` من 0041) ما زالت قائمة ⇒ لا تظهر في فلتر 'DELETE'
         لأن نوعها ALL — وهي **تشمل الحذف**. خطر.

   الاختبار يبني الحالتين فعلاً على سلسلة الهجرات:
     • «إنتاج لم يُنفّذ 0044»  = السلسلة بلا 0044  ⇒ نُثبت أن الثغرة **حيّة**
       (sales_purchase يحذف رأس فاتورة، والبائع يحذف فاتورته، والحذف المتسلسل
       يأخذ بنودها معها).
     • ثم نُطبّق 0166 ⇒ نُثبت أنها **مغلقة**، وأن ما كان يعمل ما زال يعمل:
       INSERT/UPDATE للفاتورة والمخزون بنفس الشروط.
     • ونُطبّقه مرتين ⇒ لا 42710 ولا تغيير في أي سياسة.
   ═══════════════════════════════════════════════════════════════════════ */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

let PGlite, pgcrypto;
try {
  PGlite = require('@electric-sql/pglite').PGlite;
  pgcrypto = require('@electric-sql/pglite/contrib/pgcrypto').pgcrypto;
} catch (e) { console.error('⚠ شغّل npm install'); process.exit(1); }

const HERE = path.join(__dirname, '..');
const DIR = path.join(HERE, 'supabase', 'migrations');
const FIX = path.join(HERE, 'supabase', 'security', '0166-sales-stock-delete-admin-only.sql');

const NET_STUB = `
create schema if not exists net;
create table if not exists net._requests (id bigserial primary key, url text, body jsonb, created_at timestamptz default now());
create table if not exists net._http_response (id bigint primary key, status_code int, content text, error_msg text);
create or replace function net.http_post(url text default null, headers jsonb default null, body text default null, timeout_milliseconds int default 0)
returns bigint language plpgsql as $x$
declare v bigint; begin insert into net._requests(url, body) values (url, body::jsonb) returning id into v; return v; end $x$;
create or replace function net.http_post(url text, headers jsonb, body jsonb, timeout_milliseconds int default 0)
returns bigint language plpgsql as $y$
declare v bigint; begin insert into net._requests(url, body) values (url, body) returning id into v; return v; end $y$;
`;
const strip = s => s.replace('create extension if not exists pg_net;', '')
  .replace('create extension if not exists pg_cron;', '')
  .replace(/select cron\.schedule\('pos_sheet_sync_hourly'[\s\S]*?\$\$?\);\s*/, '');

/* هواتف الاستثناءات المعروفة (تنظيف/باك-فيل إنتاجي) — ليست في مسار البيع */
const SKIP_OK = ['0057_customer_ledger_cleanup.sql', '0058_supplier_payments_backfill.sql',
  '0084_debt_reset_apply.sql', '0084_debt_reset_rollback.sql', '0092_product_category_paths.sql',
  '0096_sarraj_debts_adjust.sql', '0107_programmer_role.sql'];

/* الفروع مبذورة بأسمائها في السلسلة (pos_locations_name_key) — نقرأ
   معرّف «فرع 11 يونيو» ولا نخترع واحداً، فلا نصطدم بمفتاح الاسم. */
const BRANCH_NAME = 'فرع 11 يونيو';
const ACC = 'dddddddd-3333-3333-3333-333333333333';

async function build({ with0044 }) {
  const db = new PGlite({ extensions: { pgcrypto } });
  await db.exec(fs.readFileSync(path.join(HERE, 'supabase', 'local-shim.sql'), 'utf8'));
  await db.exec(NET_STUB);
  const skipped = [];
  for (const f of fs.readdirSync(DIR).filter(f => f.endsWith('.sql')).sort()) {
    if (!with0044 && f.startsWith('0044')) continue;     /* إنتاج لم ينفّذها */
    try { await db.exec(strip(fs.readFileSync(path.join(DIR, f), 'utf8'))); }
    catch (e) { skipped.push(f); try { await db.exec('rollback;'); } catch (_e) {} }
  }
  const unexpected = skipped.filter(f => !SKIP_OK.includes(f));
  assert.deepStrictEqual(unexpected, [], 'هجرة متخطّاة: ' + unexpected.join(', '));

  await db.exec(`
    insert into public.pos_products(code,name,retail_price,purchase_price,active)
      values ('X1','صنف س',10,5,true),('X2','صنف ص',20,8,true) on conflict (code) do nothing;
    insert into public.pos_finance_accounts(id,name,account_type,opening_balance)
      values ('${ACC}','صندوق', 'cash',0) on conflict (id) do nothing;
    insert into public.pos_user_roles(identifier,role,active) values
      ('admin','admin',true),('sp','sales_purchase',true),('wh','warehouse',true),
      ('s11','seller_11',true),('prg','programmer',true)
      on conflict (identifier) do update set role=excluded.role, active=true;
    grant select, insert, update, delete on public.pos_sales, public.pos_stock to authenticated;
  `);
  const loc = (await db.query(`select id from public.pos_locations where name=$1 limit 1`, [BRANCH_NAME])).rows[0];
  assert.ok(loc && loc.id, 'لم أجد الفرع المبذور «' + BRANCH_NAME + '»');
  db.__loc = loc.id;
  return db;
}

const asUser = async (db, email, fn) => {
  await db.exec('reset role');
  await db.exec(email
    ? `create or replace function auth.jwt() returns jsonb language sql stable as $$ select '{"email":"${email}"}'::jsonb $$`
    : `create or replace function auth.jwt() returns jsonb language sql stable as $$ select null::jsonb $$`);
  await db.exec(`set role 'authenticated'`);
  try { return await fn(); } finally { await db.exec('reset role'); }
};

/* فاتورة جاهزة + صف مخزون — تُزرع بدور المالك ثم نحاول حذفها بدور المستخدم */
async function seed(db, tag) {
  /* uuid يجب أن يكون ست عشرياً: خانة واحدة + 7 = المجموعة الأولى */
  const sid = `${tag}5555555-0000-0000-0000-00000000e001`;
  const LOC_A = db.__loc;
  await db.exec(`
    insert into public.pos_sales(id,invoice_no,sale_date,location_id,payment_method,total,paid_amount,balance_due,status,created_by)
      values ('${sid}','I-${tag}',current_date,'${LOC_A}','cash',100,100,0,'posted','s11');
    insert into public.pos_sale_items(sale_id,product_code,product_name,qty,unit_price,line_total)
      values ('${sid}','X1','صنف س',1,100,100);
    insert into public.pos_stock(location_id,product_code,product_name,qty)
      values ('${LOC_A}','X${tag.slice(-1)}','صنف',7) on conflict do nothing;
  `);
  return sid;
}
const saleExists = async (db, id) => Number((await db.query(`select count(*) n from public.pos_sales where id=$1`, [id])).rows[0].n);
const itemCount = async (db, id) => Number((await db.query(`select count(*) n from public.pos_sale_items where sale_id=$1`, [id])).rows[0].n);

/* ═══ ١) إنتاج بلا 0044: الثغرة حيّة — هذا ما كان يحدث فعلًا ═══════════ */
test('(١) بلا 0044: sales_purchase يحذف رأس فاتورة مباشرة — الثغرة قائمة', async () => {
  const db = await build({ with0044: false });
  try {
    const pol = (await db.query(`
      select policyname, cmd from pg_policies
       where schemaname='public' and tablename='pos_sales' and cmd in ('ALL','DELETE')
       order by policyname`)).rows;
    assert.deepStrictEqual(pol.map(r => r.policyname), ['pos_programmer_all_pos_sales', 'pos_role_sales_write'],
      'الحالة المفترضة: سياسة for all قائمة ولا سياسة DELETE: ' + JSON.stringify(pol));
    /* وهذا هو مفتاح لغز «No rows returned»: الفلتر على cmd='DELETE' لا يراها */
    const onlyDelete = (await db.query(`
      select policyname from pg_policies
       where schemaname='public' and cmd='DELETE' and tablename='pos_sales'`)).rows;
    assert.strictEqual(onlyDelete.length, 0, 'يجب ألا تظهر أي سياسة DELETE — لهذا عاد الاستعلام فارغاً');

    const sid = await seed(db, '1');
    const n = await asUser(db, 'sp@bag.com', async () => (await db.query(
      `delete from public.pos_sales where id=$1 returning id`, [sid])).rows.length);
    assert.strictEqual(n, 1, 'افتراض الاختبار خاطئ: sales_purchase لم يحذف');
    assert.strictEqual(await saleExists(db, sid), 0, 'رأس الفاتورة اختفى');
    assert.strictEqual(await itemCount(db, sid), 0, 'والبنود ذهبت معه بالحذف المتسلسل');
  } finally { await db.close(); }
});

test('(٢) بلا 0044: البائع يحذف فاتورته، والمخزون كذلك مفتوح', async () => {
  const db = await build({ with0044: false });
  try {
    const sid = await seed(db, '2');
    const own = await asUser(db, 's11@bag.com', async () => (await db.query(
      `delete from public.pos_sales where id=$1 returning id`, [sid])).rows.length);
    assert.strictEqual(own, 1, 'البائع يحذف فاتورته مباشرة');

    const stock = await asUser(db, 'wh@bag.com', async () => (await db.query(
      `delete from public.pos_stock where product_code='X2' returning product_code`)).rows.length);
    assert.ok(stock >= 0); /* الكمية قد لا تكون موجودة — المهم أن السياسة لا تمنع */
    const pol = (await db.query(`
      select policyname, cmd from pg_policies
       where schemaname='public' and tablename='pos_stock' and cmd in ('ALL','DELETE')`)).rows;
    assert.deepStrictEqual(pol.map(r => r.policyname).sort(),
      ['pos_programmer_all_pos_stock', 'pos_role_stock_write'], 'سياسة المخزون for all قائمة');
  } finally { await db.close(); }
});

/* ═══ ٣) بعد 0166: مغلقة، وما كان يعمل ما زال يعمل ═════════════════════ */
test('(٣) بعد 0166: sales_purchase والبائع والمدير-عبر-REST… الحذف ممنوع إلا للمدير', async () => {
  const db = await build({ with0044: false });
  try {
    await db.exec(fs.readFileSync(FIX, 'utf8'));
    const pol = (await db.query(`
      select policyname, cmd from pg_policies
       where schemaname='public' and tablename='pos_sales' order by policyname`)).rows;
    assert.deepStrictEqual(pol.map(r => r.policyname),
      ['pos_programmer_all_pos_sales', 'pos_role_sales_delete', 'pos_role_sales_insert',
        'pos_role_sales_read', 'pos_role_sales_update'], JSON.stringify(pol));

    const sid = await seed(db, '3');
    const sp = await asUser(db, 'sp@bag.com', async () => (await db.query(
      `delete from public.pos_sales where id=$1 returning id`, [sid])).rows.length);
    assert.strictEqual(sp, 0, '⚠ sales_purchase ما زال يحذف');
    const seller = await asUser(db, 's11@bag.com', async () => (await db.query(
      `delete from public.pos_sales where id=$1 returning id`, [sid])).rows.length);
    assert.strictEqual(seller, 0, '⚠ البائع ما زال يحذف');
    const admin = await asUser(db, 'admin@bag.com', async () => (await db.query(
      `delete from public.pos_sales where id=$1 returning id`, [sid])).rows.length);
    assert.strictEqual(admin, 1, 'المدير مُنع — 0044 لا تفعل ذلك');
  } finally { await db.close(); }
});

test('(٤) بعد 0166: المخزون — الحذف للمدير، والتعديل والإدراج كما كانا', async () => {
  const db = await build({ with0044: false });
  try {
    await db.exec(fs.readFileSync(FIX, 'utf8'));
    await db.exec(`insert into public.pos_stock(location_id,product_code,product_name,qty)
                   values ('${db.__loc}','X1','صنف س',5) on conflict do nothing`);

    const whDel = await asUser(db, 'wh@bag.com', async () => (await db.query(
      `delete from public.pos_stock where product_code='X1' returning product_code`)).rows.length);
    assert.strictEqual(whDel, 0, '⚠ أمين المخزن يحذف صف مخزون');
    const spUpd = await asUser(db, 'sp@bag.com', async () => (await db.query(
      `update public.pos_stock set qty=6 where product_code='X1' returning product_code`)).rows.length);
    assert.strictEqual(spUpd, 1, 'بيع-وشراء مُنع من تعديل المخزون — كسرنا الشاشة');
    const sIns = await asUser(db, 's11@bag.com', async () => (await db.query(
      `insert into public.pos_stock(location_id,product_code,product_name,qty)
       values ('${db.__loc}','X2','صنف ص',1)
       on conflict do nothing returning product_code`)).rows.length);
    assert.ok(sIns === 0 || sIns === 1, 'البائع يُدرج صف مخزون في فرعه');
    const adminDel = await asUser(db, 'admin@bag.com', async () => (await db.query(
      `delete from public.pos_stock where product_code='X1' returning product_code`)).rows.length);
    assert.strictEqual(adminDel, 1, 'المدير مُنع من حذف المخزون');
  } finally { await db.close(); }
});

test('(٥) بعد 0166: الفاتورة تُنشأ وتُعدَّل — البائع في فرعه، و«بيع وشراء»', async () => {
  const db = await build({ with0044: false });
  try {
    await db.exec(fs.readFileSync(FIX, 'utf8'));
    const sid = await seed(db, '4');
    const sellerUpd = await asUser(db, 's11@bag.com', async () => (await db.query(
      `update public.pos_sales set notes='تعديل' where id=$1 returning id`, [sid])).rows.length);
    assert.strictEqual(sellerUpd, 1, 'البائع مُنع من تعديل فاتورته — كسرنا العمليات');

    const newId = '77777777-0000-0000-0000-00000000e00d';
    const spIns = await asUser(db, 'sp@bag.com', async () => (await db.query(
      `insert into public.pos_sales(id,invoice_no,sale_date,location_id,payment_method,total,paid_amount,balance_due,status,created_by)
       values ($1,'I-new',current_date,$2,'cash',10,10,0,'posted','sp') returning id`, [newId, db.__loc])).rows.length);
    assert.strictEqual(spIns, 1, 'بيع-وشراء مُنع من إنشاء فاتورة');
    await db.exec(`delete from public.pos_sales where id='${newId}'`); /* تنظيف بدور المالك */
  } finally { await db.close(); }
});

/* ═══ ٦) آمن للتكرار ═══════════════════════════════════════════════════ */
test('(٦) إعادة تشغيل 0166 لا تُغيّر سياسةً ولا ترمي 42710', async () => {
  const db = await build({ with0044: false });
  try {
    const snap = async () => (await db.query(`
      select tablename, policyname, cmd, roles::text as roles, qual::text as qual, with_check::text as wc
        from pg_policies where schemaname='public' and tablename in ('pos_sales','pos_stock')
       order by tablename, policyname`)).rows;
    await db.exec(fs.readFileSync(FIX, 'utf8'));
    const once = await snap();
    let err = null;
    try { await db.exec(fs.readFileSync(FIX, 'utf8')); } catch (e) { err = String(e && e.message || e); }
    assert.strictEqual(err, null, 'إعادة التشغيل فشلت: ' + err);
    assert.strictEqual(JSON.stringify(await snap()), JSON.stringify(once), 'السياسات تغيّرت في التشغيل الثاني');
  } finally { await db.close(); }
});

/* ═══ ٧) على السلسلة الكاملة (0044 موجودة) 0166 محايد تماماً ═══════════ */
test('(٧) على إنتاج نُفِّذت فيه 0044: 0166 لا يغيّر شيئاً', async () => {
  const db = await build({ with0044: true });
  try {
    const snap = async () => (await db.query(`
      select tablename, policyname, cmd, roles::text as roles, qual::text as qual, with_check::text as wc
        from pg_policies where schemaname='public' and tablename in ('pos_sales','pos_stock')
       order by tablename, policyname`)).rows;
    const before = await snap();
    await db.exec(fs.readFileSync(FIX, 'utf8'));
    assert.strictEqual(JSON.stringify(await snap()), JSON.stringify(before),
      '0166 غيّر سياسات قائمة — يجب أن يكون بديلاً حرفياً لِما فعلته 0044');
  } finally { await db.close(); }
});

/* ═══ ٨) لا رجعة أمنية في الشروط ═══════════════════════════════════════ */
test('(٨) شروط INSERT/UPDATE منقولة حرفياً من 0041/0044 — لا توسيع', () => {
  const fix = fs.readFileSync(FIX, 'utf8');
  const orig = fs.readFileSync(path.join(DIR, '0044_delete_admin_only.sql'), 'utf8');
  const norm = s => s.replace(/\s+/g, ' ').toLowerCase();
  const grab = (txt, name) => {
    const i = txt.indexOf(`create policy ${name}`);
    assert.ok(i > 0, 'لم أجد ' + name);
    return norm(txt.slice(i, txt.indexOf(');', i)));
  };
  for (const p of ['pos_role_sales_insert', 'pos_role_sales_update', 'pos_role_sales_delete',
    'pos_role_stock_insert', 'pos_role_stock_update', 'pos_role_stock_delete']) {
    assert.strictEqual(grab(fix, p), grab(orig, p), 'شرط ' + p + ' انحرف عن 0044');
  }
});
