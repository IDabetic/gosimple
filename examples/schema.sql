-- GENERISAN FAJL — ne menjajte ga ručno.
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
  ('ad-001',
   'NGK svećice BKR6E-11 komplet 4 kom',
   'Set od 4 svećice NGK BKR6E-11 sa niklovanom elektrodom. Navoj 14 mm, dužina navoja 19 mm, zazor 1,1 mm, ključ 16 mm. Odgovara motorima Subaru EJ20 i EJ25, kao i Opel 1.6 16V. Preporučeni interval zamene 30.000 km.',
   'auto-delovi', 'NGK', 2400,
   true, 1840, 212,
   '2026-03-11T10:00:00Z', ARRAY['svećice', 'subaru', 'opel', 'paljenje']::text[]),

  ('ad-002',
   'Bosch svećice Super Plus FR7DC komplet 4 kom',
   'Svećice Bosch FR7DC, navoj 14 mm, zazor 0,8 mm, otpor 5 kΩ. Bakarna jezgra za brže odvođenje toplote. Namenjene benzinskim motorima 1.4 do 2.0. Testirano na 60.000 km bez pada performansi.',
   'auto-delovi', 'Bosch', 1950,
   true, 1320, 140,
   '2026-01-20T10:00:00Z', ARRAY['svećice', 'benzin', 'paljenje', 'golf']::text[]),

  ('ad-003',
   'Bobina paljenja Subaru Impreza 2.0',
   'Originalna bobina paljenja za Subaru Impreza 2.0 benzin, godište 2008 do 2014. Otpor primara 0,7 Ω, sekundara 11 kΩ. Radni napon 12 V. Konektor sa 3 pina.',
   'auto-delovi', 'Subaru', 7800,
   true, 420, 31,
   '2026-05-02T10:00:00Z', ARRAY['bobina', 'subaru', 'paljenje']::text[]),

  ('ad-004',
   'Filter ulja Mann W712/75',
   'Filter ulja Mann W712/75, prečnik 76 mm, visina 85 mm, navoj M20x1,5. Ugrađeni nepovratni ventil. Za motore 1.6 i 1.8 benzin.',
   'auto-delovi', 'Mann', 890,
   true, 2100, 390,
   '2025-11-14T10:00:00Z', ARRAY['filter', 'ulje', 'servis']::text[]),

  ('ad-005',
   'Kočione pločice prednje Brembo P85020',
   'Komplet prednjih kočionih pločica Brembo P85020. Debljina 17,5 mm, visina 69,2 mm, dužina 155,1 mm. Sa senzorom habanja.',
   'auto-delovi', 'Brembo', 5400,
   false, 760, 54,
   '2026-02-08T10:00:00Z', ARRAY['kočnice', 'pločice']::text[]),

  ('br-001',
   'Solarne baštenske svećice LED, set 6 kom',
   'Set od 6 solarnih svećica za baštu. Punjenje solarnim panelom 2 V / 40 mA, baterija 600 mAh, autonomija 8 sati. Visina 38 cm, zaštita IP44. Efekat treperenja plamena. Automatsko paljenje u sumrak.',
   'bastenska-rasveta', 'Lumi', 3200,
   true, 2900, 310,
   '2026-04-18T10:00:00Z', ARRAY['svećice', 'bašta', 'solarna', 'led']::text[]),

  ('br-002',
   'Baštenski lampion od kovanog gvožđa 45 cm',
   'Lampion za baštu i terasu, kovano gvožđe sa staklom debljine 3 mm. Visina 45 cm, prečnik osnove 18 cm, težina 1,9 kg. Za sveće prečnika do 8 cm. Otporan na kišu.',
   'bastenska-rasveta', 'Vrt', 2750,
   true, 880, 72,
   '2026-05-30T10:00:00Z', ARRAY['lampion', 'bašta', 'terasa']::text[]),

  ('br-003',
   'Solarna baštenska svetiljka za stazu, 8 kom',
   'Kvalitetno rešenje za vašu baštu. Vrhunski materijali i moderan dizajn čine ovaj proizvod idealnim izborom. Pouzdan rad i elegantan izgled zadovoljiće sve vaše potrebe. Savršen izbor za svaki dom.',
   'bastenska-rasveta', 'Sun', 2100,
   true, 1400, 61,
   '2026-06-01T10:00:00Z', ARRAY['solarna', 'bašta', 'staza']::text[]),

  ('br-004',
   'Solarna lampa za dvorište, komplet 8 kom',
   'Kvalitetno rešenje za vaše dvorište. Vrhunski materijali i moderan dizajn čine ovaj proizvod idealnim izborom. Pouzdan rad i elegantan izgled zadovoljiće sve vaše potrebe. Savršen izbor za svaki dom.',
   'bastenska-rasveta', 'Sun', 2050,
   true, 640, 22,
   '2026-06-03T10:00:00Z', ARRAY['solarna', 'dvorište']::text[]),

  ('pd-001',
   'LED lampice za jelku 200 dioda, 20 m',
   'Novogodišnje lampice sa 200 LED dioda na kablu dužine 20 m. Napajanje 230 V preko adaptera 31 V, potrošnja 4,8 W. Osam programa svetlosnih efekata. Za unutrašnju i spoljnu upotrebu, IP44.',
   'praznicna-dekoracija', 'Nova', 1890,
   true, 3400, 520,
   '2025-11-05T10:00:00Z', ARRAY['lampice', 'jelka', 'novogodišnje', 'led']::text[]),

  ('pd-002',
   'LED svećice za jelku bežične, 10 kom',
   'Bežične LED svećice sa štipaljkom za granu jelke. Baterija CR2032, trajanje 60 sati, topla bela boja 2700 K. Visina 10 cm. Daljinski upravljač sa tajmerom na 6 sati.',
   'praznicna-dekoracija', 'Nova', 2400,
   true, 1720, 198,
   '2025-11-22T10:00:00Z', ARRAY['svećice', 'jelka', 'led', 'praznik']::text[]),

  ('pd-003',
   'Ukrasne sveće set 3 kom, bela',
   'Set od tri ukrasne sveće od parafina, visine 10, 15 i 20 cm, prečnik 7 cm. Vreme gorenja 25 do 50 sati. Bez mirisa, pamučni fitilj.',
   'praznicna-dekoracija', 'Dekor', 1200,
   true, 910, 88,
   '2025-12-01T10:00:00Z', ARRAY['sveća', 'ukras', 'praznik']::text[]),

  ('kr-001',
   'LED sijalica E27 9W, topla bela',
   'LED sijalica sa grlom E27, snaga 9 W, svetlosni fluks 806 lm, temperatura boje 2700 K. Ekvivalent sijalici od 60 W. Vek trajanja 25.000 sati, indeks reprodukcije boja CRI 80.',
   'kucna-rasveta', 'Osram', 420,
   true, 4200, 980,
   '2025-09-10T10:00:00Z', ARRAY['sijalica', 'led', 'e27']::text[]),

  ('kr-002',
   'Luster trokraki za dnevnu sobu, crni',
   'Plafonski luster sa tri grla E27, metalna konstrukcija u crnoj boji. Prečnik 48 cm, visina podesiva od 30 do 90 cm. Maksimalna snaga po grlu 40 W.',
   'kucna-rasveta', 'Lux', 6900,
   true, 530, 26,
   '2026-07-19T10:00:00Z', ARRAY['luster', 'plafon', 'dnevna']::text[]);
