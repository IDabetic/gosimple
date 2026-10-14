// Isti motor kao prodavnica.gs, samo iz PostgreSQL-a umesto iz JSON fajla.
//
// Pokretanje:
//   createdb shop && psql shop -f examples/schema.sql
//   export GOSIMPLE_PG="korisnik:lozinka@127.0.0.1:5432/shop"
//   gs run examples/prodavnica-pg.gs -q "svećice za Subaru"
//
// Konekcioni string se čita iz okruženja, pa lozinka ne ulazi ni u ovaj
// fajl ni u IR plan — oboje mogu slobodno u git.
//
// Nazivi kolona namerno ne odgovaraju GoSimple poljima — tako izgleda
// zatečena baza, i zato map blok postoji.

source products from "postgres://${GOSIMPLE_PG}" {
  table "products"

  map {
    id          "product_id"
    title       "name"
    description "descr"
    category    "category_slug"
    brand       "brand_name"
    price       "price_rsd"
    available   "in_stock"
    views       "view_count"
    purchases   "order_count"
    createdAt   "created"
    tags        "label_list"
  }

  where "deleted_at IS NULL"
  limit 50000
}

taxonomy {
  category "auto-delovi" {
    terms   ["svećica", "svećice", "bobina", "filter", "pločice"]
    signals ["subaru", "golf", "motor", "benzin", "paljenje", "impreza"]
  }

  category "bastenska-rasveta" {
    terms   ["svećica", "svećice", "lampion", "svetiljka"]
    signals ["bašta", "terasa", "dvorište", "solarno", "staza"]
    season  [prolece, leto]
  }

  category "praznicna-dekoracija" {
    terms   ["svećica", "svećice", "lampice", "sveća"]
    signals ["jelka", "božić", "praznik", "nova godina"]
    season  [zima]
  }

  category "kucna-rasveta" {
    terms   ["sijalica", "luster", "rasveta"]
    signals ["plafon", "dnevna soba", "e27", "stan"]
  }
}

intent Discovery {
  rule "auto-kontekst" {
    when signal of "auto-delovi"
    then category "auto-delovi"
    confidence 0.95
    lock
  }

  rule "basta-kontekst" {
    when signal of "bastenska-rasveta"
    then category "bastenska-rasveta"
    confidence 0.9
    lock
  }

  rule "praznik-kontekst" {
    when signal of "praznicna-dekoracija"
    then category "praznicna-dekoracija"
    confidence 0.9
    lock
  }

  fallback ambiguous when confidence < 0.6
}

engine ProductDiscoveryPg {
  use source products
  use intent Discovery

  search {
    retrieve 300 candidates
    match { keywords weight 1.0  category weight 0.6 }

    rank by {
      query_relevance    0.35
      category_match     0.25
      seasonal_relevance 0.15
      popularity         0.10
      content_quality    0.10
      freshness          0.05
    }

    protect intent
    diversify by category max 4
    exclude unavailable
    explain every result
    return top 8
  }
}
