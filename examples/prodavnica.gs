# GoSimple — pretraga proizvoda sa zaštitom namere
#
# Problem koji ovaj program rešava: reč "svećice" u srpskom znači i auto-deo,
# i baštensku dekoraciju, i novogodišnji ukras. Sezonski signal sam za sebe bi
# u decembru vozača koji traži svećice za Subaru odveo na lampice za jelku.
#
# Rešenje: signali konteksta zaključavaju nameru, a `protect intent` sprečava
# sezonu i popularnost da je prepišu.

source products from "catalog.json"
events from "events.json"

taxonomy {
  category "auto-delovi" {
    terms   ["svećica", "svećice", "bobina", "filter", "pločice", "akumulator"]
    signals ["subaru", "golf", "opel", "passat", "motor", "benzin", "dizel", "auto", "vozilo", "ngk"]
  }

  category "bastenska-rasveta" {
    terms   ["svećica", "svećice", "sveća", "lampa", "lampion", "sijalica", "rasveta", "svetiljka"]
    signals ["bašta", "baštenska", "terasa", "dvorište", "solarna", "napolju", "vrt"]
    season  [prolece, leto]
  }

  category "praznicna-dekoracija" {
    terms   ["svećica", "svećice", "lampice", "sijalica", "ukras", "sveća"]
    signals ["jelka", "jelku", "novogodišnje", "božić", "praznik", "praznična"]
    season  [zima]
  }

  category "kucna-rasveta" {
    terms   ["sijalica", "sijalice", "luster", "lampa", "led"]
    signals ["plafon", "soba", "dnevna", "unutrašnja"]
  }
}

intent Discovery {
  detect from query, context

  rule "auto-kontekst" {
    when signal of "auto-delovi"
    then category "auto-delovi"
    confidence 0.95
    lock
  }

  rule "bastenski-kontekst" {
    when signal of "bastenska-rasveta"
    then category "bastenska-rasveta"
    confidence 0.9
    lock
  }

  rule "praznicni-kontekst" {
    when signal of "praznicna-dekoracija"
    then category "praznicna-dekoracija"
    confidence 0.9
    lock
  }

  rule "kucni-kontekst" {
    when signal of "kucna-rasveta"
    then category "kucna-rasveta"
    confidence 0.85
    lock
  }

  fallback ambiguous when confidence < 0.6
}

engine ProductDiscovery {
  use source products
  use intent Discovery

  search {
    retrieve 300 candidates

    match {
      keywords weight 1.0
      category weight 0.6
    }

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

  recommend {
    learn from [views, clicks, add_to_cart, purchases]

    factors {
      collaborative 0.45
      content       0.20
      season        0.15
      popularity    0.10
      interests     0.10
    }

    // Četvrtina liste ide kategorijama van istorije korisnika. Bez tog
    // ventila preporuke se zatvore u krug: preporučiš ono što je gledao,
    // on klikne, pa to preporučiš još jače.
    explore 0.25

    exclude recently_seen
    return top 6
  }

  content {
    analyze [ai_patterns, naturalness, specificity, duplication, completeness]
    score quality
    score originality
  }
}
