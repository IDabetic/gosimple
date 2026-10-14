| `GS2106` | `table` i `map` na izvoru koji nije SQL se ignorišu |
| `GS2107` | `recommend` bez `learn from` || `GS2044` | SQL izvor ne mapira `id`, `title` i `category` |
| `GS2045` | `limit` nije pozitivan || `GS2040` | nepoznato polje dokumenta u `map` bloku |
| `GS2041` | SQL izvor nema navedenu tabelu |
| `GS2042` | `where` sadrži# GoSimple — specifikacija jezika v0.1

Ovaj dokument opisuje ono što je **implementirano i pokriveno testovima**. Konstrukcije koje nisu implementirane su izričito označene.

## 1. Leksička struktura

Izvorni fajl je UTF-8 tekst. Nova linija i razmak nemaju značenje osim kao razdvajači.

- **Komentari:** od `#` ili `//` do kraja linije.
- **Identifikatori:** počinju unicode slovom ili `_`, nastavljaju se slovom, cifrom, `_`, `.` ili `-`. Srpska slova rade bez escape-ovanja.
- **Stringovi:** dvostruki navodnici, escape sekvence `\n \t \r \" \\`. Ne smeju da prelaze liniju.
- **Brojevi:** celi i decimalni (`300`, `0.35`). Bez eksponenta.
- **Logičke vrednosti:** `true`, `false`.
- **Interpunkcija:** `{ } [ ] , : < > <= >= =`

Ključne reči **nisu rezervisane**. Parser iz pozicije zaključuje da li identifikator deluje kao ključna reč, pa naziv kategorije ili polja nikada ne može da se sudari sa rečnikom jezika.

## 2. Gramatika

```ebnf
program     = { declaration } ;
declaration = source | events | taxonomy | intent | engine ;

source      = "source" IDENT "from" STRING [ "{" { srcProp } "}" ] ;
srcProp     = "table" STRING
            | "map" "{" { IDENT STRING } "}"
            | "where" STRING
            | "limit" NUMBER ;

events      = "events" "from" STRING ;

taxonomy    = "taxonomy" "{" { category } "}" ;
category    = "category" STRING "{" { catProp } "}" ;
catProp     = ( "terms" | "signals" | "season" ) [ ":" ] list ;
list        = "[" [ item { "," item } ] "]" ;
item        = STRING | IDENT ;

intent      = "intent" IDENT "{" { detect | rule | fallback } "}" ;
detect      = "detect" "from" IDENT { "," IDENT } ;
rule        = "rule" STRING "{"
                "when" "signal" "of" STRING
                "then" "category" STRING
                { "confidence" NUMBER | "lock" }
              "}" ;
fallback    = "fallback" "ambiguous" "when" "confidence" "<" NUMBER ;

engine      = "engine" IDENT "{" { use | search | recommend | content } "}" ;
use         = "use" ( "source" | "intent" ) IDENT ;

search      = "search" "{" { searchStmt } "}" ;
searchStmt  = "retrieve" NUMBER [ "candidates" ]
            | "match" "{" { IDENT [ "weight" ] NUMBER [ "," ] } "}"
            | "rank" "by" "{" { IDENT [ "weight" ] NUMBER [ "," ] } "}"
            | "protect" "intent"
            | "diversify" "by" IDENT [ "max" NUMBER ]
            | "exclude" "unavailable"
            | "explain" [ "every" ] [ "result" ]
            | "return" "top" NUMBER ;

recommend   = "recommend" "{" { recStmt } "}" ;
recStmt     = "learn" "from" [ ":" ] list
            | "account" "for" [ ":" ] list
            | "factors" "{" { IDENT [ "weight" ] [ ":" ] NUMBER } "}"
            | "explore" [ ":" ] NUMBER
            | "exclude" "recently_seen"
            | "return" "top" NUMBER ;

content     = "content" "{" { "analyze" [ ":" ] list | "score" IDENT } "}" ;
```

## 3. Semantika

### 3.1 Taksonomija

`terms` su reči koje **mogu** da upućuju na kategoriju. Preklapanje između kategorija je očekivano i predstavlja dvosmislenost koju jezik razrešava.

`signals` su reči konteksta koje dvosmislenost **razrešavaju**. Signal koji pripada dvema kategorijama ne može pouzdano da zaključa nameru, pa kompajler na to upozorava (`GS2104`).

`season` navodi godišnja doba u kojima kategorija dobija sezonski bust. Dozvoljeno: `prolece`, `leto`, `jesen`, `zima`. Mapiranje datuma na doba je meteorološko (mart–maj, jun–avgust, septembar–novembar, decembar–februar).

### 3.2 Razrešavanje namere

Za upit se izvršava sledeći redosled:

1. Upit se normalizuje: ćirilica → latinica, mala slova, uklanjanje dijakritika, uklanjanje stopwordova, blago skraćivanje nastavaka.
2. Svaki token se traži u indeksu termina. Rezultat je skup kategorija-kandidata.
3. Svaki token se traži u indeksu signala.
4. Pravila se primenjuju **redom deklaracije**; prvo koje se poklopi pobeđuje.
5. Ako nijedno pravilo nije aktivirano, a postoji tačno jedan kandidat, namera je taj kandidat sa pouzdanošću 0,75 i **nije zaključana**.
6. Ako ima više kandidata, pouzdanost je `1 / broj kandidata`. Ispod `fallback` praga upit se označava kao dvosmislen i vraća se pitanje za pojašnjenje.

### 3.3 Zaštita namere

Kada je `protect intent` aktivno **i** namera zaključana:

1. **Filtriranje:** uklanjaju se dokumenti iz *konkurentskih* kategorija, odnosno onih koje su bile kandidati ali nisu izabrane. Kategorije van skupa kandidata se ne diraju, jer sa ovim upitom nikad nisu ni bile zamenljive. Ako bi filtriranje uklonilo baš sve, preskače se i to se beleži u tragu — prazna stranica je gora od labave.
2. **Potiskivanje:** kontekstualni signali se postavljaju na nulu. Trenutno je to samo `seasonal_relevance`. `popularity` se namerno **ne** potiskuje: ona može da pomeri rezultat samo preko granice kategorije, a te granice su već filtrirane, pa unutar zaključane kategorije ostaje koristan signal poretka.
3. **Preraspodela težine:** težina potisnutog signala se proporcionalno deli na preostale, umesto da se izgubi. Bez toga bi svaki skor pri zaključanoj nameri tiho opao i skorovi zaključanih i nezaključanih upita ne bi bili uporedivi.

### 3.4 Faze poklapanja i rangiranja

Ovo su **dve odvojene faze**, kao u ozbiljnim pretraživačima:

- `match` određuje **ko je uopšte kandidat**. Dokument je kandidat ako mu je zbir match vrednosti veći od nule.
- `rank` određuje **poredak** kandidata.

Razdvajanje je nužno: bez njega dokument bez ikakve veze sa upitom i dalje skuplja poene od signala nezavisnih od upita (svežina, kvalitet teksta) i izbija na svaku stranicu.

Match polja: `keywords` (leksičko poklapanje), `category` (pripadnost razrešenoj nameri), `semantic` (kosinusna sličnost vektora upita i dokumenta).

Za `semantic` postoje dva provajdera i odgovor uvek prijavljuje koji je bio aktivan kroz `vectorMode`:

| `vectorMode` | Provajder | Šta zaista meri |
|---|---|---|
| `lexical-vector` | lokalni, podrazumevani | heširani karakterski trigrami — pravopisnu sličnost, ne značenje |
| `semantic` | OpenAI-kompatibilni endpoint | značenje |

Razlika je imenovana namerno. Lokalni provajder ne radi mrežne pozive i ništa ne košta, ali nazvati ga „semantičkim" značilo bi obećati razumevanje koje nema.

Match faza ne prolazi kroz ceo katalog. Runtime drži invertovani indeks
`term → pozicije` i `kategorija → pozicije`, pa kandidate uzima kao uniju
lista za tokene upita i za kategorije razrešene namere. Ovo je **sužavanje,
a ne aproksimacija**: match vrednost veću od nule može da donese samo
`keywords` (traži zajednički token) ili `category` (traži pripadnost
kandidatima namere), pa dokument van obe unije ionako ne bi prošao prag.
Izuzetak je `semantic`, koji po definiciji može da poveže upit sa
dokumentom bez zajedničke reči; kada je taj signal uključen, faza se vraća
na pun prolaz.

Tvrdnja o jednakosti se proverava, ne pretpostavlja. `tests/match-index.test.ts`
pokreće oba puta nad istim katalogom i zahteva identičan odgovor.

### 3.5 Rank signali

Svi vraćaju vrednost u `[0, 1]`.

| Signal | Izračunavanje |
|---|---|
| `query_relevance` | udeo tokena upita prisutnih u dokumentu; naslov se broji dvaput |
| `category_match` | 1 za zaključanu kategoriju, 0,25 za konkurentsku, 0 inače |
| `seasonal_relevance` | 1 ako kategorija ima bust za trenutno doba |
| `popularity` | `log1p(pregledi) / log1p(maks. pregleda)` |
| `freshness` | eksponencijalno opadanje, poluvreme 90 dana |
| `user_interest` | poklapanje interesovanja korisnika sa dokumentom |
| `purchase_intent` | stopa konverzije, zasićenje na 20% |
| `content_quality` | iz analize sadržaja |
| `originality` | `1 − poklapanje sa katalogom` |
| `price_fit` | 1 unutar budžeta, linearno do 0 na dvostrukom budžetu |

Konačni skor je `Σ(signal × težina) / Σ(težina)`, pa je uvek u `[0, 1]`. Pri jednakim skorovima presuđuje ID, što izvršavanje čini determinističkim.

`originality` meri poklapanje opisa sa ostatkom kataloga preko Žakarove
mere nad šinglovima od četiri reči. Poređenje svakog sa svakim je kvadratno
i na 100 000 proizvoda neupotrebljivo, pa runtime prvo grupiše tekstove
koji su identični (njihovo poklapanje je 1 bez ijednog poređenja), zatim
preko invertovanog indeksa nad šinglovima nalazi samo one dokumente koji
zaista dele neki šingl, i tek nad tom šačicom računa **tačnu** meru.

Jedini približan korak je biranje kandidata: dokument čiji su baš svi
šinglovi rasprostranjeni kroz katalog može da dobije odsečen spisak
kandidata. To se dešava jedino unutar velikog klastera sličnog teksta, gde
su članovi ionako zamenjivi. Smer greške je određen — rezultat sme da bude
**niži** od tačnog, nikada viši, jer se svaki prijavljeni broj računa nad
stvarnim skupovima. Pošten opis zato ne može da bude lažno optužen za
prepisivanje. `tests/duplication.test.ts` upoređuje brzi put sa poređenjem
svih sa svima i traži da se poklope.

### 3.6 Diverzifikacija

`diversify by <polje> max <n>` dozvoljava najviše `n` rezultata po vrednosti polja u gornjem delu liste. Višak se **premešta na kraj, a ne briše**, pa stranica nikada nije kraća nego što je traženo.

### 3.7 Preporuke

Strategija se bira iz raspoloživih ulaza i **uvek se prijavljuje u odgovoru**:

| Strategija | Uslov | Oslonac |
|---|---|---|
| `warm` | korisnik ima istoriju | ko-pojavljivanje sa onim što je već gledao |
| `cool` | nema istorije, ali postoji `seedIds` | sličnost sa zadatim artiklom |
| `cold` | ni jedno ni drugo | popularnost i sezona |

Faktori i težine se deklarišu kroz `factors { ... }`, ili kroz `account for [...]` kada su podrazumevane težine dovoljne. Oba oblika u istom bloku su greška (`GS2025`).

| Faktor | Podrazumevana težina | Izračunavanje |
|---|---|---|
| `collaborative` | 0,45 | kosinusna sličnost vektora korisnika po artiklu |
| `content` | 0,20 | poklapanje kategorije i oznaka sa istorijom |
| `season` | 0,15 | sezonski bust, prigušen afinitetom korisnika |
| `popularity` | 0,10 | `log1p(pregledi) / log1p(maks.)` |
| `interests` | 0,10 | poklapanje navedenih interesovanja sa oznakama |
| `price` | 0,10 | uklapanje u budžet |

**Preraspodela težine.** `collaborative` i `content` zahtevaju istoriju ili seed, pa pri `cold` strategiji ne mogu ništa da daju. Njihova težina se **srazmerno deli na preostale faktore** umesto da se izgubi. Bez toga bi svaki cold-start skor bio deo odgovarajućeg warm skora i dva se ne bi mogla porediti. Isto pravilo kao u 3.3.

Ako su svi deklarisani faktori zavisni od istorije, kompajler upozorava (`GS2109`), jer novi posetilac tada ne dobija ništa.

**Sezona prigušena afinitetom.** Sezonski doprinos se množi sa `0,3 + 0,7 × afinitet`, gde je afinitet udeo angažovanja korisnika u toj kategoriji. Kupac koji kupuje isključivo auto-delove tako u decembru ne dobija novogodišnje ukrase na prvom mestu. Pri `cold` strategiji prigušenja nema — nema istorije koja bi sezoni protivrečila. Prigušenje se **ispisuje u obrazloženju**, ne primenjuje se tiho.

Ovo je ista zaštita kao `protect intent`, samo na drugoj putanji: tamo kontekst upita zaključava nameru, ovde je istorija korisnika štiti.

**Istraživanje.** `explore <udeo>` rezervisе deo liste za kategorije van istorije korisnika. Bez tog ventila sistem preporučuje ono što je korisnik gledao, korisnik klikne, i to pojačava sledeću preporuku — povratna sprega koja se sama zatvara.

**Odbijanja.** Događaji tipa `dismissals` se poštuju i kada nisu navedeni u `learn from`, i proveravaju se **pre** provere „već viđeno" (korisnik gotovo uvek pogleda artikal pre nego što ga odbije, pa bi obrnut redosled svako odbijanje pripisao pasivnom pregledu).

### 3.8 Izvori podataka

`source ... from "<uri>"` bira adapter po šemi: putanja bez šeme je JSON fajl, `postgres://` ili `postgresql://` je PostgreSQL.

**Kredencijali.** URI podržava `${PROMENLJIVA}`, koja se čita iz okruženja **pri pokretanju, ne pri kompajliranju**:

```
source products from "postgres://${GOSIMPLE_PG}" { … }
```

Posledica je da IR plan zadržava doslovno `${GOSIMPLE_PG}`, pa `gs plan` i `GET /plan` mogu da se dele bez ičega poverljivog, a isti plan radi u svim okruženjima. Šema se čita iz sirovog URI-ja, pre zamene, da bi kompajler razlikovao JSON od SQL izvora i kada okruženje nije prisutno.

Nepostavljena promenljiva je greška pri pokretanju koja navodi sva imena koja nedostaju odjednom. Lozinka upisana doslovno daje upozorenje `GS2111` — `.gs` fajl je izvorni kod i ide u git.

Za SQL izvore važi:

1. Imena tabele i kolona moraju da odgovaraju `^[A-Za-z_][A-Za-z0-9_]*$` (`GS2043`), provereno u vreme kompajliranja **i ponovo** pri sastavljanju upita.
2. `map` mora da pokrije bar `id`, `title` i `category` (`GS2044`).
3. `where` se **parsira**, ne proverava obrascem. Vidi 3.9.
4. `LIMIT` se uvek dodaje, i kada nije naveden.
5. `describe()` prikazuje samo host i tabelu. Konekcioni string se nigde ne ispisuje.

### 3.9 Gramatika `where` uslova

`where` nije sirov SQL koji se prosleđuje dalje. Parsira se u stablo izraza i SQL se **ponovo sastavlja** iz tog stabla: identifikatori se proveravaju i stavljaju pod navodnike, a svaki literal odlazi kao vezani parametar (`$1`, `$2`, …). Ništa iz originalnog teksta ne završi u upitu.

```ebnf
where     = orExpr ;
orExpr    = andExpr { "OR" andExpr } ;
andExpr   = notExpr { "AND" notExpr } ;
notExpr   = "NOT" notExpr | primary ;
primary   = "(" orExpr ")" | "TRUE" | "FALSE" | predicate ;
predicate = IDENT ( "IS" [ "NOT" ] "NULL"
                  | [ "NOT" ] "IN" "(" literal { "," literal } ")"
                  | [ "NOT" ] "LIKE" literal
                  | "ILIKE" literal
                  | cmpOp literal ) ;
cmpOp     = "=" | "<>" | "!=" | "<" | "<=" | ">" | ">=" ;
literal   = STRING | NUMBER | "TRUE" | "FALSE" ;
```

Ključne reči nisu osetljive na veličinu slova. Sve što gramatika ne može da predstavi je greška `GS2042` sa pozicijom u uslovu: podupiti, `UNION`, pozivi funkcija, kastovi, poređenje dve kolone.

**Zašto ovako, a ne filtriranjem opasnih znakova.** Raniji pristup je odbijao `;`, `--` i `/*`. To je blok-lista, i pala je na prvom ulazu koji ih ne koristi:

```
where "false UNION SELECT username, password_hash, category_slug FROM users"
```

Taj uslov ne sadrži nijedan zabranjen znak, uredno se nadovezuje na `SELECT` i vraća sadržaj druge tabele kao da su proizvodi. Napad je reprodukovan protiv žive baze i izvukao hešove lozinki. Blok-liste na SQL-u ne rade jer brane od primera, a ne od gramatike. Integracioni test u `tests/postgres.integration.test.ts` izvršava upravo taj napad protiv prave baze pri svakom CI pokretanju.

## 4. Dijagnostika

### Greške

| Kod | Uslov |
|---|---|
| `GS1000` | leksička greška |
| `GS1001` | sintaksna greška |
| `GS2001` | nepoznat ili nejednoznačan izvor |
| `GS2002` | nepoznat intent |
| `GS2003` | pravilo referencira nepostojeću kategoriju |
| `GS2004` | nepoznat rank signal ili prazan rank blok |
| `GS2005` | nepoznato match polje ili prazan match blok |
| `GS2007` | pouzdanost van opsega `[0, 1]` |
| `GS2008` | **`protect intent` bez deklarisanog intenta** |
| `GS2010` | `retrieve` manji od `return top` |
| `GS2011` | duplirana kategorija |
| `GS2012` | nepoznato ili nevalidno `diversify` polje |
| `GS2013` | ponovljen signal ili polje |
| `GS2014` | program nema engine |
| `GS2015` | negativna težina |
| `GS2016` | više od jednog engine bloka |
| `GS2017` | prazan engine |
| `GS2020` | nepoznat događaj u `learn from` |
| `GS2021` | nepoznat faktor u `account for` ili `factors` |
| `GS2022` | `return top` nije pozitivan |
| `GS2023` | `recommend` uči iz događaja, a dnevnik nije deklarisan |
| `GS2024` | više od jednog `events` bloka |
| `GS2025` | `account for` i `factors` u istom bloku |
| `GS2026` | faktor naveden više puta |
| `GS2027` | težina faktora van opsega `(0, 1]` |
| `GS2028` | `explore` van opsega `[0, 1)` |
| `GS2030`–`GS2031` | nepoznata analiza ili ocena u `content` bloku |
| `GS2042` | `where` sadrži `;`, `--` ili `/*` |
| `GS2043` | ime tabele ili kolone nije validan identifikator |
| `GS2044` | SQL izvor ne mapira `id`, `title` i `category` |

### Upozorenja

| Kod | Uslov |
|---|---|
| `GS2006` | zbir rank težina nije 1,0 |
| `GS2009` | `seasonal_relevance` ima težinu, a nijedna kategorija nema sezonu |
| `GS2101` | kategorija bez termina |
| `GS2102` | pravilo se oslanja na kategoriju bez signala, pa se nikada ne aktivira |
| `GS2103` | **sezonski signal bez `protect intent`** |
| `GS2104` | signal pripada dvema kategorijama |
| `GS2105` | `semantic` polje koristi lokalni provajder, koji meri pravopis a ne značenje |
| `GS2107` | `recommend` bez `learn from` |
| `GS2108` | `recommend` nema nijedan faktor |
| `GS2109` | **svi faktori zavise od istorije, pa novi posetilac ne dobija ništa** |
| `GS2110` | `where` uslov ne pominje nijednu kolonu, pa je konstanta |
| `GS2111` | **konekcioni string sadrži lozinku umesto `${PROMENLJIVE}`** |

`GS2008` i `GS2103` su razlog zbog kog jezik postoji. Prvi je greška jer je tiha zaštita koja ne radi gora od nikakve; drugi je upozorenje jer je legitimno svesno izabrati sezonski bust bez zaštite.

## 5. IR i kompatibilnost

IR je JSON sa poljem `irVersion`. Runtime odbija plan čiju verziju ne razume umesto da pogađa semantiku. Trenutna verzija je `1`.

IR sadrži i unapred izračunate invertovane indekse (`termToCategories`, `signalToCategory`, `seasonToCategories`), pa je traženje termina pri upitu pogodak u mapu umesto prolaska kroz sve kategorije.

## 6. Determinizam

Isti plan, isti katalog, isti upit i isti `now` uvek daju identičan izlaz — isti dokumenti, isti skorovi do poslednje decimale, isti redosled.

Jedino polje koje se razlikuje između dva izvršavanja je `stats.durationMs`, jer je to merenje sata a ne odluka mašine za rangiranje. CI ga uklanja pre poređenja (`scripts/strip-timing.mjs`); obećati „bajt-identično" sa njim unutra bilo bi netačno.

Signali koji zavise od vremena (`freshness`, `seasonal_relevance`) čitaju `now` iz zahteva, nikada sistemski sat, kada je prosleđen. Pri jednakim skorovima presuđuje ID, pa ni redosled ne zavisi od redosleda obilaska.

Bez ove osobine promene u rangiranju nije moguće recenzirati niti reprodukovati regresiju.
