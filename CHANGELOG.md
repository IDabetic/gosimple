# Changelog

Format prati [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
verzionisanje je [semantičko](https://semver.org/lang/sr/).

## [Neobjavljeno]

### Promenjeno

- **Podizanje engine-a više nije kvadratno.** Originalnost se računala
  poređenjem svakog opisa sa svakim, pa je katalog od 10 000 proizvoda
  trošio 29,4 s, a 100 000 nije završavalo. Sada se identični tekstovi prvo
  grupišu, a za ostale invertovani indeks nad šinglovima bira samo one
  dokumente koji zaista dele neki šingl. Podizanje na 10 000 je 1,3 s, na
  100 000 je 20,7 s.
- **Match faza više ne prolazi kroz ceo katalog.** Kandidati se uzimaju iz
  invertovanog indeksa `term → pozicije` i `kategorija → pozicije`. p50 na
  100 000 proizvoda je pao sa 169 ms na 43 ms, p95 sa 497 ms na 96 ms.

Nijedna od ove dve izmene ne menja rezultate pretrage. Oba brza puta imaju
test koji ih poredi sa sporom, očiglednom implementacijom i traži identičan
izlaz (`tests/duplication.test.ts`, `tests/match-index.test.ts`), a
`Engine` ima opciju `scanAllDocuments` koja postoji isključivo da bi ta
provera bila moguća.

### Dodato

- **`gs eval`** — ocena rangiranja nad zlatnim skupom upita: NDCG@k sa
  stepenovanim ocenama, preciznost, odziv, MRR, i poređenje dva plana upit
  po upitu (`--compare`). Do sada se izmena rangiranja mogla braniti samo
  utiskom, iako `CONTRIBUTING.md` traži brojke.

  Zlatni skup uz svaki upit nosi i spisak dokumenata koji **ne smeju** da
  izađu. To nije dodatak nego suština: zaštita namere je tvrdnja o tome šta
  mora da izostane, a prosečne mere relevantnosti je ne mogu iskazati. Nad
  isporučenim primerom uklanjanje `protect intent` pomera prosečan NDCG za
  0,018, dok broj prekršenih zabrana ide sa 0 na 3. `gs eval` zato vraća
  izlazni kod različit od nule čim jedan zabranjen dokument izađe.

- `examples/zlatni-skup.json` i `examples/prodavnica-bez-zastite.gs` —
  drugi postoji da bi šteta od uklonjene zaštite namere mogla da se izmeri,
  a ne samo opiše.
- Dva nova CI koraka: isporučeni plan mora da prođe zlatni skup, a plan bez
  `protect intent` mora da padne. Drugi čuva od toga da skup neprimetno
  prestane da meri ono zbog čega postoji.
- `npm run benchmark` — sintetički katalozi od 1 000 do 100 000 proizvoda,
  p50/p95/p99 i podizanje prijavljeni odvojeno.
- `npm run catalog` — deterministički generator kataloga (Zipf-ova raspodela
  popularnosti, namerno dvosmislen pojam „svećice", klasteri prepisanog
  marketinškog teksta).
- **Inkrementalni indeks.** `Engine.reload(docs)` dopunjuje katalog bez
  restarta. Originalnost, koja zavisi od suseda, se održava indeksom koji
  preračunava samo pogođene dokumente. Posle svake izmene rezultat je isti
  kao da je engine podignut iz nule — to proverava 150 nasumičnih operacija
  i deset scenarija nad pravim katalogom.

  HTTP `POST /reload` samo ponovo čita izvor sa kog je server pokrenut.
  Telo zahteva se **odbija**, ne ignoriše: ignorisanje je kako kasnija
  izmena „od pomoći" počne da prima katalog preko mreže. Endpoint je
  zatvoren dok nije postavljen `GOSIMPLE_TOKEN`. Dva istovremena zahteva
  dele jedno učitavanje.

### Ispravljeno

- Dva identična prazna opisa više ne dobijaju duplikaciju 1. Tekst kraći od
  jednog šingla ne daje nikakav dokaz, a modul za sadržaj ne iznosi tvrdnje
  koje ne može da potkrepi.

## [0.1.0] — 2026-10-14

Prvo javno izdanje. Jezik je upotrebljiv od početka do kraja: program se
kompajlira, plan se izvršava, rezultat se objašnjava.

### Dodato

**Jezik i kompajler**

- Deklaracije `source`, `events`, `taxonomy`, `intent` i `engine`.
- Leksika sa punom Unicode podrškom za identifikatore; ključne reči nisu
  rezervisane, pa kategorija sme da se zove `source` ili `rank`.
- Semantička provera sa 30+ dijagnostika, svaka sa kodom `GS<broj>` i
  predlogom najbližeg imena kada je u pitanju greška u kucanju.
- Verzionisani JSON IR (`IR_VERSION = 1`) sa predračunatim obrnutim
  indeksima za termine, signale i sezone.
- Tri Serbian-specifične množine u CLI izlazu (1 greška / 2 greške /
  5 grešaka).

**Zaštita namere**

- `protect intent` — kontekstualni signal u upitu zaključava nameru, nakon
  čega sezona ne sme da je prebije. Ovo je razlog zbog kog jezik postoji.
- `GS2008`: `protect intent` bez deklarisane namere je greška.
- `GS2103`: sezonski signal bez `protect intent` je upozorenje.
- Preraspodela težine: kada se signal priguši, njegova težina se srazmerno
  raspoređuje na ostale, pa su rezultati zaključanog i nezaključanog upita
  i dalje uporedivi.
- Prigušenje se prikazuje u objašnjenju rezultata, ne krije se.

**Pretraga**

- Razdvojene faze `match` (podobnost) i `rank` (redosled). Dokument koji ne
  prođe `match` ne može da se popne na vrh zbog signala nezavisnih od upita.
- 11 rang signala, svaki sa vidljivim doprinosom u odgovoru.
- Deterministično izvršavanje: isti plan, dokumenti, upit i `now` daju
  identičan izlaz, do poslednje decimale. Jedini izuzetak je izmereno
  trajanje zahteva. Provereno u zasebnom CI poslu.

**Obrada srpskog teksta**

- Preslikavanje ćirilice u latinicu, sklapanje digrafa i dijakritika.
  `свећице за Субару` i `svećice za Subaru` daju identične rezultate.
- Stopwords i konzervativno korenovanje (minimum 4 znaka).

**Preporuke**

- `recommend` blok sa `learn from` listom tipova događaja.
- Tri strategije: `warm` (istorija korisnika), `cool` (slično artiklu),
  `cold` (popularnost i sezona). Strategija je uvek vidljiva u odgovoru.
- Težine faktora se deklarišu u jeziku (`factors { ... }`) ili se uzimaju
  podrazumevane (`account for [...]`); oba oblika zajedno su greška `GS2025`.
- Preraspodela težine na cold startu: `collaborative` i `content` ne mogu
  ništa da daju bez istorije, pa njihova težina ide srazmerno na ostale
  faktore. Bez toga cold i warm skorovi ne bi bili na istoj skali.
- Item-item ko-pojavljivanje sa kosinusnom normalizacijom, čime bestseleri
  prestaju da dominiraju svakom listom.
- Sezonski podsticaj prigušen afinitetom: kupac koji kupuje isključivo
  auto-delove ne dobija novogodišnje ukrase na prvom mestu u decembru.
  Prigušenje se ispisuje u obrazloženju.
- `explore <udeo>` rezerviše deo liste za kategorije van istorije korisnika,
  kao protivteža povratnoj sprezi.
- `GS2109` upozorava kada svi faktori zavise od istorije, jer novi posetilac
  tada ne dobija ništa.
- Odbijanja (`dismissals`) se poštuju i kada nisu navedena u `learn from`.
- Svaka preporuka nosi obrazloženje sortirano po doprinosu.

**Sadržajna inteligencija**

- `content` blok: preklapanje rečenica sa ostatkom kataloga, udeo praznih
  fraza, prisustvo konkretnih specifikacija, procena kvaliteta i originalnosti.
- Nalazi su **dokazi sa stepenom pouzdanosti, nikada presuda o autorstvu**.
  Pouzdanost opada sa kratkim tekstom. Testovi proveravaju da nijedan dokaz
  ne tvrdi da je tekst napisao AI.

**Izvori podataka**

- `SourceAdapter` apstrakcija sa JSON i PostgreSQL implementacijama.
- Mapiranje kolona, `where` i `limit` u `source` bloku.
- SQL identifikatori se proveravaju protiv allowliste u vreme kompajliranja
  i ponovo pri sastavljanju upita (`GS2043`, `GS2044`).
- **`where` uslov ima sopstvenu gramatiku.** Parsira se u stablo izraza i SQL
  se ponovo sastavlja iz njega; literali odlaze kao vezani parametri. Podupiti,
  `UNION`, pozivi funkcija i kastovi su greška `GS2042` sa pozicijom. Vidi
  „Ispravljena ranjivost" ispod.
- `${PROMENLJIVA}` u konekcionom stringu, zamenjuje se pri pokretanju a ne pri
  kompajliranju, pa IR plan ne sadrži kredencijale. Lozinka upisana doslovno
  daje upozorenje `GS2111`.
- `describe()` prikazuje samo host ili ime fajla, nikada kredencijale ni punu
  putanju na disku.
- Integracioni testovi protiv žive PostgreSQL instance: konverzija tipova
  (`numeric`, `timestamptz`, `text[]`, `boolean`), filtriranje kroz `where`,
  i dokaz da ista pretraga nad bazom i nad JSON-om daje identične skorove.

### Ispravljena ranjivost

**SQL injekcija kroz `where` uslov.** Prva implementacija je uslov proveravala
odbacivanjem `;`, `--` i `/*`, i ta kontrola je bila dokumentovana kao
bezbednosna. Bila je blok-lista i propustila je:

```
where "false UNION SELECT username, password_hash, category_slug FROM users"
```

Napad ne sadrži nijedan zabranjen znak. Reprodukovan je protiv žive baze i
izvukao hešove lozinki iz druge tabele. Zamenjen je gramatikom koja ume da
izrazi samo filtriranje redova, a sam napad se sada izvršava kao test pri
svakom CI pokretanju. Detalji u [SECURITY.md](SECURITY.md).

**Semantička pretraga**

- `EmbeddingProvider` apstrakcija sa poštenim imenovanjem: lokalni provajder
  se predstavlja kao `lexical-vector`, ne kao `semantic`, jer to i jeste —
  heširani karakterski trigrami bez mreže.
- OpenAI-kompatibilni adapter (`semantic`) radi i protiv Ollama endpointa.

**Integracija**

- HTTP runtime: `POST /search`, `POST /recommend`, `POST /content`,
  `GET /plan`, `GET /health`.
- PHP SDK (`sdk/php`) i TypeScript SDK (`sdk/ts`) za Laravel, Next.js, Vue
  i React.

**Bezbednost**

- Runtime nikada ne kompajlira `.gs` program iz mrežnog zahteva; planovi se
  kompajliraju jednom pri pokretanju, sa diska.
- Server se vezuje isključivo na `127.0.0.1`.
- Ograničenja: 64 KB telo, 512 znakova upit, 32 interesovanja, 500 id-jeva,
  5 s timeout, 300 zahteva u minutu.
- CORS zabranjen podrazumevano, uključuje se preko `GOSIMPLE_CORS_ORIGINS`.
- Bearer tokeni se porede konstantnim vremenom; `X-Forwarded-For` se namerno
  ne veruje.
- Nula zavisnosti u runtime-u, provereno u CI-ju.

### Poznata ograničenja

Namerno nabrojana, da ne biste otkrivali u produkciji. Puna lista je u
[SECURITY.md](SECURITY.md) i u odeljku „Šta v0.1 NE radi" u README-u.

- Indeks je u memoriji i linearan; prikladno za desetine hiljada dokumenata,
  ne za milione.
- Rate limiting je po procesu, ne deljen između instanci.
- Nema inkrementalnog indeksiranja — izmena kataloga traži restart.
- Lokalni embeddinzi hvataju pravopisnu sličnost, ne značenje.
- Normalizacija teksta je podešena za srpski.

[0.1.0]: https://github.com/IDabetic/gosimple/releases/tag/v0.1.0
