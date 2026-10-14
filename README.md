# GoSimple

[![CI](https://github.com/IDabetic/gosimple/actions/workflows/ci.yml/badge.svg)](https://github.com/IDabetic/gosimple/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A522.18-green.svg)](package.json)
[![Zavisnosti](https://img.shields.io/badge/runtime%20zavisnosti-0-green.svg)](package.json)

Deklarativni jezik za pretragu, rangiranje i preporuke, sa jednom osobinom koju postojeći alati nemaju kao prvorazredni koncept: **zaštitu namere**.

```
svećice                 → dvosmisleno, sistem pita umesto da pogađa
svećice za Subaru       → auto-delovi, zaključano, sezona ne može da pomeri rezultat
svećice za baštu        → baštenska rasveta, zaključano
```

U decembru, upit „svećice za Subaru" u običnom pretraživaču sa sezonskim bustom lako završi na lampicama za jelku. GoSimple to sprečava na nivou jezika, a ne na nivou ad-hoc koda u svakoj aplikaciji posebno.

---

## Zašto postoji

Elasticsearch, OpenSearch i Vespa sve ovo **mogu** da urade. Problem je što kod njih morate ručno da napišete logiku razrešavanja namere za svaki upit, u svakoj aplikaciji, i da je održavate kad se katalog promeni. GoSimple tu logiku pretvara u deklarativno pravilo koje se kompajlira, proverava i radi isto iz Laravela, Next.js-a i Vue-a.

Konkretno, kompajler odbija program koji traži `protect intent` bez deklarisanog intenta (greška `GS2008`), i upozorava kad koristite sezonski signal **bez** zaštite (`GS2103`). Ta klasa grešaka kod konkurencije prolazi tiho i otkrije se tek kad kupac prijavi da mu pretraga nudi gluposti.

## Brzi start

Potreban je Node 22.18 ili noviji — od te verzije Node izvršava TypeScript direktno, bez dodatne zastavice i bez build koraka.

```bash
cd gosimple-lang
npm install

node src/cli.ts check examples/prodavnica.gs
node src/cli.ts run   examples/prodavnica.gs -q "svećice za Subaru" --now 2026-12-15
node src/cli.ts run   examples/prodavnica.gs -q "svećice"           --now 2026-12-15
node src/cli.ts content examples/prodavnica.gs
node src/cli.ts serve examples/prodavnica.gs -p 7777
```

## Kako izgleda program

```
source products from "catalog.json"

taxonomy {
  category "auto-delovi" {
    terms   ["svećica", "svećice", "bobina"]
    signals ["subaru", "golf", "motor", "benzin"]
  }

  category "praznicna-dekoracija" {
    terms   ["svećica", "svećice", "lampice"]
    signals ["jelka", "božić", "praznik"]
    season  [zima]
  }
}

intent Discovery {
  rule "auto-kontekst" {
    when signal of "auto-delovi"
    then category "auto-delovi"
    confidence 0.95
    lock
  }
  fallback ambiguous when confidence < 0.6
}

engine ProductDiscovery {
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
```

`terms` su reči koje **mogu** da upućuju na kategoriju i smeju da se preklapaju između kategorija — to preklapanje i jeste dvosmislenost koju rešavamo. `signals` su reči konteksta koje dvosmislenost **razrešavaju** i zaključavaju nameru.

## Arhitektura

```
.gs fajl → lekser → parser → AST → provera semantike → IR plan → runtime → rezultati
```

IR je običan JSON sa verzijom. Runtime odbija plan čiju verziju ne razume umesto da pogađa. Možete ga keširati, verzionisati u gitu i uporediti dve verzije rangiranja kao običan diff:

```bash
node src/cli.ts plan examples/prodavnica.gs > plan-v1.json
```

Izvršavanje je determinističko: isti plan, isti katalog, isti upit i isti `--now` uvek daju identičan izlaz. Bez toga promene u rangiranju nije moguće recenzirati.

## Integracija

Runtime je HTTP servis, pa ga zovete iz bilo kog okruženja.

**Laravel / PHP**

```php
$gs = new \GoSimple\GoSimple('http://127.0.0.1:7777', env('GOSIMPLE_TOKEN'));

$result = $gs->search('baštenske svećice', [
    'user' => ['id' => (string) $user->id, 'budget' => 4000],
]);

if ($result->needsClarification()) {
    return view('search.clarify', ['options' => $result->clarify['options']]);
}

return view('search.results', ['hits' => $result->hits]);
```

Preporuke na početnoj, sa poštenim naslovom:

```php
$slate = $gs->recommend(['userId' => (string) $user->id, 'budget' => 4000]);

return view('home', [
    'items'   => $slate->items,
    'heading' => $slate->isPersonalized() ? 'Za vas' : 'Najtraženije ove sedmice',
]);
```

Za Laravel registrujte `GoSimple\GoSimpleServiceProvider` i podesite `GOSIMPLE_URL` i `GOSIMPLE_TOKEN` u `.env`; klijent se posle toga samo tipizuje u konstruktoru ili akciji.

**Next.js / Nuxt**

```ts
import { GoSimple } from './sdk/ts/index.ts';

const gs = new GoSimple({ baseUrl: 'http://127.0.0.1:7777', token: process.env.GOSIMPLE_TOKEN });

const result = await gs.search('svećice za Subaru');
if (result.clarify) {
  // Pitaj korisnika umesto da pogađaš.
}

const slate = await gs.recommend({ userId, seedIds: [currentProductId] });
// slate.strategy je 'warm' | 'cool' | 'cold' — naslov sekcije neka ga prati.
```

## Preporuke

Isti problem dolazi i na druga vrata. Kupac koji godinama kupuje isključivo auto-delove u decembru ne treba da dobije lampice za jelku na prvom mestu samo zato što je zima — a upravo to rade sistemi koji sezonu primenjuju ravnomerno na sve.

```
events from "events.json"

engine ProductDiscovery {
  recommend {
    learn from [views, clicks, add_to_cart, purchases]
    factors {
      collaborative 0.45
      content       0.20
      season        0.15
      popularity    0.10
      interests     0.10
    }
    explore 0.25
    exclude recently_seen
    return top 6
  }
}
```

```bash
gs recommend examples/prodavnica.gs -u u1 --now 2026-12-15T10:00:00Z
```

```
Strategija  personalizovano (istorija: 3 artikala)
Sezona      zima

 1. ████················ 0.219  Bobina paljenja Subaru Impreza 2.0
    auto-delovi
    · Deli kategoriju ili oznake sa onim što ste već razgledali.
 2. ███················· 0.152  LED svećice za jelku bežične, 10 kom
    praznicna-dekoracija
    · Kategorija "praznicna-dekoracija" je aktuelna u sezoni "zima",
      ali je prigušena jer je van vaših uobičajenih kupovina.
```

Sezonski podsticaj se množi afinitetom korisnika prema toj kategoriji. Ko ništa ne kupuje iz nje dobija 30% podsticaja umesto punog, ko iz nje već kupuje dobija pun — a prigušenje piše u obrazloženju, ne krije se.

Ako vam je svejedno koje su težine, `account for [collaborative, season, popularity]` uključuje faktore sa podrazumevanim vrednostima. Oba oblika u istom bloku su greška (`GS2025`) — ne pogađamo koji ima prednost.

Četiri odluke koje vredi znati unapred:

- **Strategija je uvek vidljiva.** `warm` znači da postoji istorija, `cool` da se polazi od zadatog artikla, `cold` da istorije nema. Sistem ne glumi da zna korisnika kog ne zna.
- **Težina se preraspodeljuje, ne gubi.** `collaborative` i `content` ne mogu ništa da daju novom posetiocu, pa njihovih 0.65 ide srazmerno na sezonu, popularnost i interesovanja. Bez toga bi cold rezultat bio trećina warm rezultata i dva se ne bi mogla porediti. Isto pravilo koje zaštita namere koristi u pretrazi.
- **Popularnost je kosinusno normalizovana.** Bez toga bestseler završi u svakoj listi, pa se preporuke svedu na rang-listu prodaje.
- **`explore` deo liste daje kategorijama van istorije korisnika.** Bez tog ventila preporuke se zatvore u krug: preporučiš ono što je gledao, on klikne, pa to još jače preporučiš.

Kompajler upozorava (`GS2109`) ako su svi faktori zavisni od istorije, jer tada novi posetilac ne dobija ništa — a to je trenutak kada preporuke najviše znače.

Odbijanja (`dismissals`) se poštuju bezuslovno, i onda kada nisu navedena u `learn from`. Ignorisati izričito „ne" nije ponašanje koje iko želi.

## Izvori podataka

JSON fajl je podrazumevani izvor, ali `source` ume i direktno iz PostgreSQL-a:

```
source products from "postgres://${GOSIMPLE_PG}" {
  table "products"
  map {
    id          "product_id"
    title       "name"
    category    "category_slug"
    views       "view_count"
    price       "price_rsd"
  }
  where "deleted_at IS NULL AND in_stock = TRUE"
  limit 50000
}
```

Potpun primer je u [`examples/prodavnica-pg.gs`](examples/prodavnica-pg.gs), sa šemom u [`examples/schema.sql`](examples/schema.sql). Isti upit nad bazom i nad JSON-om daje identične skorove — to proverava integracioni test, jer bi razlika značila da konverzija tipova negde gubi informaciju.

Tri stvari koje vredi znati:

**`where` nije sirov SQL.** Parsira se u stablo izraza i SQL se ponovo sastavlja iz njega: identifikatori idu pod navodnike, literali kao vezani parametri. Podupiti, `UNION`, pozivi funkcija i kastovi su greška pri kompajliranju (`GS2042`), sa pozicijom u uslovu.

Prva verzija je radila drugačije — odbijala je `;`, `--` i `/*`. To je blok-lista, i pala je na prvom ulazu koji ih ne koristi:

```
where "false UNION SELECT username, password_hash, category_slug FROM users"
```

Taj uslov nema nijedan zabranjen znak, uredno se nadovezuje na `SELECT` i vraća tuđu tabelu kao da su proizvodi. Reprodukovan je protiv žive baze i izvukao hešove lozinki. Sada se taj napad izvršava kao test pri svakom CI pokretanju.

**Kredencijali idu kroz okruženje.** `${GOSIMPLE_PG}` se zamenjuje pri pokretanju, ne pri kompajliranju, pa IR plan zadržava doslovno `${GOSIMPLE_PG}` i `gs plan` se može deliti. Lozinka upisana u fajl daje upozorenje `GS2111` — `.gs` fajl je izvorni kod i ide u git.

**Nalog treba da bude samo za čitanje.** Runtime nikada ne piše u bazu, pa nalog sa pravom pisanja daje više nego što je potrebno.

Za `pg` driver: `npm install pg`. Opcioni je peer, pa JSON putanja ne povlači nijednu zavisnost.

### Semantička pretraga

```
match { keywords weight 1.0  semantic weight 0.4 }
```

Podrazumevano radi lokalni provajder koji se pošteno predstavlja kao `lexical-vector`: heširani karakterski trigrami, bez mreže i bez troška. Hvata pravopisnu sličnost, ne značenje.

Za pravo značenje:

```bash
export GOSIMPLE_EMBEDDING=openai
export OPENAI_API_KEY=...
# ili lokalno, protiv bilo kog /v1/embeddings endpointa:
export GOSIMPLE_EMBEDDING_BASE_URL=http://localhost:11434/v1
```

`vectorMode` u odgovoru uvek kaže koji je režim zaista bio aktivan.

## Content Intelligence

`gs content` prijavljuje merljive osobine teksta: ujednačenost rečenica, gustinu marketinških fraza, konkretnost (mere, oznake modela), leksičku raznovrsnost i poklapanje sa ostatkom kataloga.

**Šta ovaj modul namerno NE radi:** ne tvrdi da je tekst napisao AI. Ta tvrdnja se iz samog teksta ne može pouzdano izvesti, a sistem koji je ipak iznosi pre ili kasnije kazni poštenog prodavca koji lepo piše. Umesto presude dobijate dokaze i ocenu pouzdanosti, pa politiku odlučujete vi.

```
⚠ Solarna baštenska svetiljka za stazu, 8 kom
    kvalitet ███·········  0.24   originalnost █····· 0.09
    šablonskost 0.80 uz pouzdanost 0.42
      - 18% reči su opšte marketinške fraze bez konkretne informacije.
      - Tekst se 91% poklapa sa drugim opisom u katalogu.
```

## Testovi

```bash
npm test        # 232 testa (220 bez baze)
npm run typecheck
```

Najvažniji test u celom projektu je regresioni test koji proverava da „svećice za Subaru" u decembru ne vrati nijedan novogodišnji artikal. Ako taj test ikada padne, jezik je izgubio jedini razlog zbog kog postoji.

## Ocena rangiranja

Izmena rangiranja se ne brani utiskom nego brojkama:

```bash
gs eval examples/prodavnica.gs --golden examples/zlatni-skup.json
```

Zlatni skup je lista upita sa ljudskom presudom: koji dokumenti **treba** da
izađu i koji **ne smeju**. Druga polovina je ovde važnija. Jezik postoji zato
što kupac koji u decembru traži svećice za Subaru ne sme da dobije
novogodišnje lampice, a to je tvrdnja o tome šta mora da izostane. Prosečne
mere relevantnosti je ne umeju iskazati.

Evo iste prodavnice sa uklonjenim `protect intent`, izmerene:

```
Ukupno  NDCG 0.966 → 0.983  +0.018   MRR 1.000 → 1.000   =0.000
poboljšano 1, pogoršano 0, prekršaja 3 → 0
```

Prosek se pomerio za 0,018 — unutar šuma. Da se kvalitet ocenjivao samo njime,
brisanje zaštite namere prošlo bi kao bezazlena izmena. Broj prekršenih
zabrana ide sa 3 na 0 i to je jedini broj koji je ovde rekao istinu. Zato
`gs eval` vraća grešku čim jedan zabranjen dokument izađe, bez obzira na
prosek, i zato CI pokreće i obrnutu proveru: ako plan bez `protect intent`
ikada prođe zlatni skup, skup je prestao da meri ono zbog čega postoji.

Poređenje dva plana, upit po upit:

```bash
gs eval novi.gs --golden zlatni-skup.json --compare stari.gs
```

## Merenja

```bash
npm run benchmark
```

Sintetički katalog, jedan Apple Silicon, Node 25, sedam upita, 200 ponavljanja po veličini:

| proizvoda | podizanje | p50 | p95 | p99 | memorija |
|---|---|---|---|---|---|
| 1 000 | 83 ms | 0,74 ms | 3,2 ms | 9,6 ms | 15 MB |
| 10 000 | 1,3 s | 3,5 ms | 8,0 ms | 9,8 ms | 104 MB |
| 100 000 | 20,7 s | 43 ms | 96 ms | 195 ms | 428 MB |

Podizanje i upit se prijavljuju odvojeno zato što se razlikuju za tri reda veličine, pa bi jedan zbirni broj krio ono što zapravo boli. Podizanje se plaća jednom pri pokretanju; p95 je ono što kupac oseti.

Dva koraka su bila kvadratna i više nisu: poređenje opisa radi originalnosti i prolazak kroz ceo katalog pri poklapanju. Na 10 000 proizvoda podizanje je bilo 29,4 s, sada je 1,3 s; 100 000 ranije nije završavalo uopšte. Nijedan od ta dva popravka ne menja rezultate — i jedan i drugi imaju test koji poredi brzi put sa sporim i traži identičan izlaz.

## Šta v0.1 NE radi

Ovo je spisak stvarnih granica, ne roadmap:

- **Razmera.** Indeks je u memoriji. Sto hiljada proizvoda radi (vidi merenja ispod), milion ne. Nema inkrementalnog indeksiranja — izmena kataloga traži restart.
- **Lokalni embeddinzi nisu značenje.** Podrazumevani provajder se zato i predstavlja kao `lexical-vector`, a ne kao `semantic`: heširani karakterski trigrami hvataju pravopisnu sličnost, pa će „svećica" i „sveća" biti blizu, ali „sijalica" i „rasveta" neće. Za pravo značenje treba `GOSIMPLE_EMBEDDING=openai`, što znači mrežni poziv i trošak.
- **Jezik.** Normalizacija je podešena za srpski. Drugi jezici će proći kroz cevovod, ali stopwords i korenovanje im neće odgovarati.
- **Rate limiting je po procesu.** Iza load balancera svaka instanca broji zasebno.
- **Jedan engine po fajlu.**
- **Bez A/B infrastrukture.** Jezik objašnjava zašto je rezultat takav kakav jeste, ali ne meri da li je bolji od alternative.

Od adaptera postoje JSON i PostgreSQL; MySQL, OpenSearch i ClickHouse ne postoje.

## Licenca

Apache-2.0. Vidi [SECURITY.md](SECURITY.md) za bezbednosni model i prijavu ranjivosti, i [SPEC.md](SPEC.md) za gramatiku i semantiku.
