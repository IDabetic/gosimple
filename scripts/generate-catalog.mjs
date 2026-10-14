/**
 * Generates a synthetic catalogue for benchmarking.
 *
 *   node scripts/generate-catalog.mjs 100000 > /tmp/big.json
 *
 * The data has to resemble a real catalogue or the benchmark measures the
 * wrong thing. Two properties matter most:
 *
 *   Term frequency is skewed. A handful of words appear in most products and
 *   the long tail appears a few times each. An inverted index looks great on
 *   uniformly distributed terms and ordinary on realistic ones, so the
 *   generator uses a Zipf-like distribution.
 *
 *   Ambiguity is preserved. "svećice" belongs to three categories here just
 *   as it does in examples/catalog.json, because intent resolution is the
 *   part of the query path most likely to become the bottleneck once the
 *   match phase stops being one.
 *
 * Output is deterministic for a given size and seed, so two benchmark runs
 * compare the same corpus.
 */

/** Mulberry32: small, fast, and repeatable across machines and Node versions. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CATEGORIES = [
  {
    slug: 'auto-delovi',
    terms: ['svećice', 'bobina', 'filter', 'pločice', 'amortizer', 'remen', 'pumpa', 'senzor'],
    brands: ['NGK', 'Bosch', 'Denso', 'Mann', 'Brembo', 'Sachs', 'Valeo'],
    context: ['Subaru', 'Golf', 'Astra', 'Octavia', 'Passat', 'motor', 'benzin', 'dizel'],
    tags: ['paljenje', 'servis', 'motor', 'kočnice'],
  },
  {
    slug: 'bastenska-rasveta',
    terms: ['svećice', 'lampion', 'svetiljka', 'reflektor', 'girlanda', 'stub'],
    brands: ['Lumina', 'Eglo', 'Philips', 'Osram'],
    context: ['bašta', 'terasa', 'dvorište', 'solarno', 'staza', 'ograda'],
    tags: ['solarno', 'bašta', 'spoljašnje', 'ip44'],
  },
  {
    slug: 'praznicna-dekoracija',
    terms: ['svećice', 'lampice', 'sveća', 'venac', 'kugle', 'zvezda'],
    brands: ['Luxa', 'Candela', 'Nordic'],
    context: ['jelka', 'božić', 'praznik', 'nova godina', 'dekoracija'],
    tags: ['jelka', 'božić', 'praznik', 'led'],
  },
  {
    slug: 'kucna-rasveta',
    terms: ['sijalica', 'luster', 'rasveta', 'plafonjera', 'lampa', 'spot'],
    brands: ['Philips', 'Osram', 'Nordlux', 'Eglo'],
    context: ['plafon', 'dnevna soba', 'e27', 'e14', 'stan', 'kuhinja'],
    tags: ['led', 'e27', 'unutrašnje', 'štedljivo'],
  },
  {
    slug: 'alat',
    terms: ['bušilica', 'ključ', 'odvijač', 'brusilica', 'čekić', 'testera'],
    brands: ['Bosch', 'Makita', 'DeWalt', 'Einhell'],
    context: ['radionica', 'akumulator', 'profesionalno', 'majstor'],
    tags: ['alat', 'akumulatorsko', 'radionica'],
  },
  {
    slug: 'bela-tehnika',
    terms: ['veš mašina', 'frižider', 'šporet', 'sudomašina', 'rerna'],
    brands: ['Gorenje', 'Beko', 'Bosch', 'Samsung', 'LG'],
    context: ['kuhinja', 'ugradno', 'energetska klasa', 'inverter'],
    tags: ['kuhinja', 'ugradno', 'a-klasa'],
  },
];

/** Filler that mimics the marketing copy content intelligence flags. */
const FILLER = [
  'Savršen izbor za vaš dom.',
  'Vrhunski kvalitet po najpovoljnijoj ceni.',
  'Idealno rešenje za svaku priliku.',
  'Naručite odmah i uverite se sami.',
];

const SPECIFIC = [
  'Dimenzije 120x80x45 mm, masa 340 g.',
  'Radni napon 12 V, struja 2.4 A.',
  'Garancija 24 meseca, servis u Srbiji.',
  'Temperatura 2700 K, fluks 806 lumena.',
  'Navoj M14x1.25, dužina 19 mm.',
];

/** Zipf-like pick: index 0 is far more likely than the tail. */
function zipf(random, length) {
  return Math.min(length - 1, Math.floor(length * random() ** 2.2));
}

function generate(size, seed = 42) {
  const random = rng(seed);
  const docs = [];
  const start = Date.UTC(2025, 0, 1);
  const span = Date.UTC(2026, 9, 1) - start;

  for (let i = 0; i < size; i++) {
    const category = CATEGORIES[zipf(random, CATEGORIES.length)];
    const term = category.terms[zipf(random, category.terms.length)];
    const brand = category.brands[Math.floor(random() * category.brands.length)];
    const context = category.context[zipf(random, category.context.length)];

    const model = `${String.fromCharCode(65 + Math.floor(random() * 26))}${Math.floor(random() * 9000) + 1000}`;
    const title = `${brand} ${term} ${model} za ${context}`;

    // A fifth of the catalogue gets filler copy, matching the proportion of
    // low-effort listings in the shops this is built for.
    const body =
      random() < 0.2
        ? FILLER.join(' ')
        : `${term.charAt(0).toUpperCase()}${term.slice(1)} ${brand} ${model}, namenjeno za ${context}. ` +
          SPECIFIC[Math.floor(random() * SPECIFIC.length)];

    docs.push({
      id: `p-${String(i).padStart(7, '0')}`,
      title,
      description: body,
      category: category.slug,
      brand,
      price: Math.round((random() * 40000 + 300) / 10) * 10,
      available: random() > 0.08,
      views: Math.floor(random() ** 3 * 50000),
      purchases: Math.floor(random() ** 4 * 2000),
      createdAt: new Date(start + random() * span).toISOString(),
      tags: [
        term,
        context.split(' ')[0].toLowerCase(),
        category.tags[Math.floor(random() * category.tags.length)],
      ],
    });
  }

  return docs;
}

const size = Number(process.argv[2] ?? 10_000);
const seed = Number(process.argv[3] ?? 42);

if (!Number.isFinite(size) || size <= 0) {
  console.error('Upotreba: node scripts/generate-catalog.mjs <broj> [seed]');
  process.exit(1);
}

process.stdout.write(JSON.stringify(generate(size, seed)));
