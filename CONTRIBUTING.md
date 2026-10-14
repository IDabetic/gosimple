# Doprinos GoSimple projektu

Hvala na interesovanju. Ovaj dokument opisuje kako se radi na projektu i,
što je važnije, **po kojim pravilima se odlučuje šta ulazi u jezik**.

## Brzi start

```bash
git clone https://github.com/gosimple-lang/gosimple
cd gosimple
npm install          # samo TypeScript i tipovi; runtime nema zavisnosti
npm test             # 192 testa
npm run typecheck
```

Nema build koraka. Node 22.18+ izvršava TypeScript direktno, pa je petlja
izmena → `npm test` i traje manje od sekunde.

Integracioni testovi protiv baze se preskaču bez nje. Da ih pokrenete:

```bash
initdb -D /tmp/gs-pg -U gstest --auth=trust
pg_ctl -D /tmp/gs-pg -o "-p 55432 -k /tmp" start
createdb -h 127.0.0.1 -p 55432 -U gstest shop
GOSIMPLE_TEST_PG=postgres://gstest@127.0.0.1:55432/shop npm test
```

Provera da li sve radi:

```bash
node src/cli.ts run examples/prodavnica.gs -q "svećice za Subaru" --now 2026-12-15T10:00:00Z
```

Ako u decembru u rezultatima vidite ijedan novogodišnji ukras, nešto je
pokvareno — to je upravo scenario zbog kog jezik postoji.

## Šta tražimo

Redosled prioriteta, od najvažnijeg:

1. **Ispravke ponašanja zaštite namere.** Ako nađete upit kod kog sezona
   ili popularnost prebije zaključanu nameru, to je najvrednija prijava koju
   možemo da dobijemo. Pošaljite upit, katalog i datum.
2. **Jezička normalizacija.** Srpski je jedini jezik koji trenutno pokrivamo
   kako treba. Dodavanje drugog jezika je dobrodošlo, ali mora da ide sa
   testovima na stvarnim upitima, ne na izmišljenim.
3. **Source adapteri.** Postoje JSON i PostgreSQL. MySQL, OpenSearch i
   ClickHouse imaju smisla.
4. **Dijagnostika.** Svaka poruka o grešci koja ne kaže korisniku šta
   konkretno da uradi je bag.

## Šta ne tražimo

Ovo nije pokušaj da budemo neljubazni, nego da vam uštedimo rad na pull
requestu koji ćemo odbiti:

- **Nove rang signale bez dokaza.** Svaki signal mora da ima scenario u kom
  menja redosled na način koji postojeći signali ne mogu. Lista signala je
  namerno kratka.
- **Konfiguracione opcije za nešto što već ima dobru podrazumevanu vrednost.**
  Opcija je priznanje da ne znamo šta je ispravno.
- **Zavisnosti u runtime-u.** `dependencies` je prazan i CI to proverava.
  Ako vam treba biblioteka, verovatno treba da bude opcioni peer (kao `pg`).
- **„AI je napisao ovaj tekst" presude.** Vidi odeljak dole.
- **Benchmark brojevi bez reproducibilnog skripta.**
- **Proširenje `where` gramatike bez bezbednosnog obrazloženja.** Gramatika je
  namerno uska. Svaki novi oblik mora da pokaže da ne može da pročita ništa van
  jedne tabele; vidi `src/sources/where.ts` za razlog zbog kog je blok-lista
  odbačena.

## Pravila koja se ne pregovaraju

### 1. Determinizam

Isti plan + isti dokumenti + isti upit + isto `now` moraju da daju
**identičan** izlaz, do poslednje decimale. Jedini izuzetak je
`stats.durationMs`, koji CI uklanja pre poređenja jer meri sat, ne odluku.

Bez `Math.random()`, bez `Date.now()` u putanji
rangiranja, bez iteracije po `Set`-u čiji redosled zavisi od redosleda
umetanja koji nije stabilan.

Ako vam treba slučajnost (npr. za istraživačke slotove u preporukama),
izvedite je deterministički iz ulaza.

CI ovo proverava u zasebnom poslu.

### 2. Zaštita namere se ne zaobilazi

Kada je namera zaključana, kontekstualni signali ne smeju da je prebiju.
Trenutno je to samo `seasonal_relevance`. Dodavanje signala u
`CONTEXTUAL_SIGNALS` zahteva obrazloženje u pull requestu: zašto taj signal
može da pomeri rezultat preko granice kategorije.

Isto važi i za preporuke: sezonski podsticaj se priguši srazmerno tome
koliko korisnik zaista kupuje iz te kategorije.

### 3. Sadržajna inteligencija daje dokaze, nikad presudu

Modul `content` sme da kaže „69% rečenica se preklapa sa drugim proizvodom"
i „36% teksta su prazne fraze". Ne sme da kaže „ovo je napisao AI".

Razlog je jednostavan: ta tvrdnja se ne može dokazati, a lažno pozitivan
rezultat košta nekoga pravi novac. Testovi aktivno proveravaju da nijedan
dokaz ne sadrži tu formulaciju, i to nije slučajno.

Svaki nalaz mora da ima `confidence` koji opada sa kratkim tekstom.

### 4. Svaka dijagnostika ima kod i predlog

Format je `GS<broj>`. Opsezi:

| Opseg | Faza |
| --- | --- |
| GS1xxx | leksika i sintaksa |
| GS2xxx | semantika (2000–2049 greške, 2100+ upozorenja) |
| GS3xxx | izvršavanje |

Nova dijagnostika ide u tabelu u `SPEC.md` i dobija test. Ako korisnik može
da pogreši u imenu, poruka mora da ponudi najbliže ime
(`suggest()` u `src/diagnostics.ts` radi Levenštajnovu distancu).

### 5. Poruke su na srpskom, kod i komentari na engleskom

Sve što korisnik vidi — dijagnostika, CLI izlaz, obrazloženja rangiranja —
piše se na srpskom, uključujući ispravnu množinu (1 greška / 2 greške /
5 grešaka; vidi `pluralGreska` u `src/cli.ts`).

Identifikatori, komentari u kodu i commit poruke su na engleskom, da bi
projekat bio otvoren i za one koji ne govore srpski.

## Bezbednost

Ne otvarajte javni issue za bezbednosne probleme. Postupak i trenutno poznata
ograničenja su u [SECURITY.md](SECURITY.md).

Dva pravila koja obavezno važe za svaki PR:

- Runtime **nikada** ne kompajlira `.gs` program iz mrežnog zahteva. Planovi
  se kompajliraju jednom, pri pokretanju, sa diska.
- SQL identifikatori se proveravaju u vreme kompajliranja **i** ponovo pri
  sastavljanju upita. Dupla provera je namerna.

## Testovi

Svaka izmena ponašanja ide sa testom. Konkretno:

- Novi rang signal → test koji pokazuje da menja redosled.
- Nova dijagnostika → test koji proverava kod *i* tekst predloga.
- Ispravka baga → test koji pada pre ispravke.

Nazivi testova su na srpskom i opisuju ponašanje, ne implementaciju. Umesto
`test('resolveIntent vraća locked=true')` piše se
`test('"svećice za Subaru" u decembru NE vraća nijedan novogodišnji artikal')`.
Kada takav test padne, odmah se zna šta je korisnik izgubio.

## Pull request

- Jedna tema po PR-u.
- `npm test` i `npm run typecheck` prolaze.
- Opis sadrži *zašto*, ne samo *šta*. „Dodao sam X" nije opis; „korisnici koji
  traže Y dobijaju Z iako su tražili W" jeste.
- Ako menjate ponašanje rangiranja, priložite izlaz `gs run` pre i posle.

## Verzionisanje

Semantički. Pre 1.0 može da se menja sve, ali:

- Promena `IR_VERSION` je breaking promena i ide u CHANGELOG.
- Promena koja menja redosled rezultata za postojeći program je breaking
  promena, čak i ako je nov redosled bolji. Mora da bude zabeležena.

## Licenca

Doprinosom pristajete da vaš rad bude objavljen pod Apache License 2.0,
pod istim uslovima kao i ostatak projekta.
