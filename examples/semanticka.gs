# Primer sa vektorskim poklapanjem.
#
# Isti katalog kao prodavnica.gs, ali `match` sadrži i `semantic`, pa se
# kandidat kvalifikuje i kada nijedna reč iz upita nije doslovno u opisu.
#
# Koji provajder stoji iza toga odlučuje okruženje:
#
#   GOSIMPLE_EMBEDDING=local    (podrazumevano) — sličnost oblika reči,
#                                bez mreže i bez troška, ali ne razume
#                                značenje
#   GOSIMPLE_EMBEDDING=openai   — stvarno razumevanje značenja, uz API ključ
#
# Odgovor pretrage uvek sadrži polje `vectorMode`, pa nikada ne morate da
# nagađate koji je režim bio aktivan.

source products from "catalog.json"

taxonomy {
  category "auto-delovi" {
    terms   ["svećica", "svećice", "bobina", "filter", "pločice", "akumulator"]
    signals ["subaru", "golf", "opel", "motor", "benzin", "dizel", "auto", "ngk"]
  }

  category "bastenska-rasveta" {
    terms   ["svećica", "svećice", "sveća", "lampa", "lampion", "sijalica", "rasveta", "svetiljka"]
    signals ["bašta", "baštenska", "terasa", "dvorište", "solarna", "napolju"]
    season  [prolece, leto]
  }

  category "praznicna-dekoracija" {
    terms   ["svećica", "svećice", "lampice", "sijalica", "ukras", "sveća"]
    signals ["jelka", "novogodišnje", "božić", "praznik"]
    season  [zima]
  }

  category "kucna-rasveta" {
    terms   ["sijalica", "sijalice", "luster", "lampa", "led"]
    signals ["plafon", "soba", "dnevna", "unutrašnja"]
  }
}

intent Discovery {
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

  fallback ambiguous when confidence < 0.6
}

engine SemanticDiscovery {
  use source products
  use intent Discovery

  search {
    retrieve 300 candidates

    # Prag poklapanja je nizak, pa vektorska sličnost sama može da kvalifikuje
    # kandidata kada doslovno poklapanje izostane.
    match {
      keywords weight 1.0
      semantic weight 0.4
      category weight 0.6
    }

    rank by {
      query_relevance     0.30
      semantic_similarity 0.15
      category_match      0.20
      seasonal_relevance  0.15
      popularity          0.10
      content_quality     0.10
    }

    protect intent
    diversify by category max 4
    exclude unavailable
    explain every result

    return top 8
  }
}
