/**
 * Generates examples/schema.sql from examples/catalog.json.
 *
 * The two files describe the same catalogue for two different sources, and
 * hand-maintaining both means they drift. They already did: a retyped
 * description changed `content_quality` enough that the same query scored
 * differently depending on whether it read JSON or SQL, which is exactly the
 * kind of difference the source abstraction is supposed to make impossible.
 *
 * Run after editing the catalogue:
 *
 *   node scripts/generate-schema.mjs
 *
 * CI regenerates and fails on any diff, so the two cannot separate again.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const docs = JSON.parse(readFileSync(join(root, 'examples', 'catalog.json'), 'utf8'));

/** Quotes a value as a SQL literal. Only used on data we generate ourselves. */
function literal(value) {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return `'${String(value).replace(/'/g, "''")}'`;
}

const rows = docs.map((d) => {
  const tags = d.tags ? `ARRAY[${d.tags.map(literal).join(', ')}]::text[]` : 'NULL';
  return [
    `  (${literal(d.id)},`,
    `   ${literal(d.title)},`,
    `   ${literal(d.description ?? null)},`,
    `   ${literal(d.category)}, ${literal(d.brand ?? null)}, ${d.price ?? 'NULL'},`,
    `   ${d.available ?? 'NULL'}, ${d.views ?? 'NULL'}, ${d.purchases ?? 'NULL'},`,
    `   ${literal(d.createdAt ?? null)}, ${tags})`,
  ].join('\n');
});

const sql = `-- GENERISAN FAJL — ne menjajte ga ručno.
-- Izvor: examples/catalog.json
-- Regeneracija: node scripts/generate-schema.mjs
--
-- Šema za examples/prodavnica-pg.gs:
--
--   createdb shop
--   psql shop -f examples/schema.sql
--   gs run examples/prodavnica-pg.gs -q "svećice za Subaru"
--
-- Nazivi kolona namerno ne odgovaraju GoSimple poljima. Tako izgleda
-- zatečena baza, i zato map blok u .gs fajlu postoji.

DROP TABLE IF EXISTS products;

CREATE TABLE products (
  product_id    text PRIMARY KEY,
  name          text NOT NULL,
  descr         text,
  category_slug text NOT NULL,
  brand_name    text,
  price_rsd     numeric(10,2),
  in_stock      boolean DEFAULT true,
  view_count    integer DEFAULT 0,
  order_count   integer DEFAULT 0,
  created       timestamptz,
  label_list    text[],
  deleted_at    timestamptz
);

-- Adapter uvek filtrira po deleted_at i čita kategoriju i dostupnost,
-- pa indeksi prate upit koji se zaista šalje.
CREATE INDEX products_category_idx ON products (category_slug) WHERE deleted_at IS NULL;
CREATE INDEX products_available_idx ON products (in_stock) WHERE deleted_at IS NULL;

-- Runtime nikada ne piše u bazu. Nalog koji koristi treba da ima samo SELECT:
--
--   CREATE ROLE gosimple LOGIN PASSWORD '...';
--   GRANT CONNECT ON DATABASE shop TO gosimple;
--   GRANT USAGE ON SCHEMA public TO gosimple;
--   GRANT SELECT ON products TO gosimple;

INSERT INTO products
  (product_id, name, descr, category_slug, brand_name, price_rsd,
   in_stock, view_count, order_count, created, label_list)
VALUES
${rows.join(',\n\n')};
`;

const target = join(root, 'examples', 'schema.sql');
writeFileSync(target, sql);
console.log(`examples/schema.sql: ${docs.length} proizvoda iz catalog.json`);
