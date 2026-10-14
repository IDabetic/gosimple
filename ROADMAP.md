# GoSimple ROADMAP

Ažurirano: 14.10.2026 · važi za v0.2.0

Polazna tačka je vizija „GoSimple programski jezik”: 655 numerisanih stavki u
30 poglavlja, plus dvanaest koncepata (Intent, Policy, Knowledge, Feedback
Engine i ostali). Ovaj dokument je njena trijaža nad stvarnim kodom. Svako
„postoji” ispod je provereno u repou, uz putanju do fajla; ništa nije
prepisano iz vizije.

Rokova nema namerno. Izdanje izlazi kada su ispunjeni kriterijumi gotovosti
njegovih stavki, a ne kada istekne datum.

**Oznake:** **Postoji** (u kodu, pokriveno testom) · **Delimično** · **v0.3** ·
**v0.4** · **P1** (posle v0.4, redosled nije fiksiran) · **P2** (dugoročno) ·
**Ne radimo** (uz razlog).

## 1. Gde smo: P0 iz vizije

Vizija za prvu verziju traži osam stvari. Sedam postoji, jedna ima rupu.

| P0 stavka iz vizije | Stanje | Gde |
|---|---|---|
| Kompajler, gramatika, tipovi, IR | **Postoji** | `src/lexer.ts`, `src/parser.ts`, `src/compile.ts`; 47 dijagnostičkih kodova u `SPEC.md` §4; verzionisani IR (`IR_VERSION`), `SPEC.md` §5 |
| Pretraga i pravila rangiranja | **Postoji** | odvojene faze `match` i `rank`, 11 signala, `src/runtime/execute.ts` |
| Preporuke sa istorijom događaja | **Postoji** | `warm` / `cool` / `cold`, `src/runtime/recommend.ts` |
| Namera i sezonski kontekst | **Postoji** | `protect intent`, taksonomija, pitanje za pojašnjenje kod dvosmislenog upita; zaseban CI posao |
| PHP i TypeScript SDK | **Delimično** | `sdk/php`, `sdk/ts`; PHP SDK **nema automatski test u CI-ju** (v0.3) |
| PostgreSQL | **Postoji** | `src/sources/index.ts`, `src/sources/where.ts`; testovi protiv žive baze |
| Bezbednosne granice i resursi | **Postoji** | `SECURITY.md`; limiti tela, upita, vremena i broja zahteva |
| Testovi, evaluacija, dokumentacija, CI | **Postoji** | 241 test, `gs eval` nad zlatnim skupom, 8 CI poslova na tri operativna sistema |

Tri stvari iz vizije postoje u drugačijem obliku nego što je vizija
zamišljala, i to je svesno:

- **Evaluation Engine** je `gs eval` sa zlatnim skupom u JSON-u, a „deploy
  only if” je CI posao koji pada. Nije blok u jeziku: komanda i fajl rade isti
  posao bez nove sintakse.
- **Ranking Simulator** je `gs eval --compare stari.gs`.
- **Query Plan Explorer** je `gs plan`.

## 2. v0.3: prava prodavnica na Laravelu

Tema: da GoSimple može da zameni listing proizvoda u stvarnoj Laravel
prodavnici, bez zaobilaženja.

| # | Stavka | Vizija | Gotovo kada |
|---|---|---|---|
| 1 | **PHP SDK u CI-ju.** Posao podiže runtime i gađa svaki metod PHP klijenta. | 363, 364, 381 | posao pada čim se ijedan metod pokvari |
| 2 | **MySQL adapter.** Opcioni `mysql2` kao `pg`, ista `where` gramatika, vezani parametri. | 158 | ista pretraga nad MySQL-om i JSON-om daje identične skorove; UNION napad pada protiv žive baze u CI-ju |
| 3 | **Filteri i stranice u upitu.** Opseg cene, dostupnost, kategorija iz zahteva; kursor za sledeću stranu. Polja filtera prolaze kroz allowlistu iz plana, nikad kao izraz. | 80, 81, 374 | strana 2 nikad ne ponavlja i ne preskače dokument (test nad nasumičnim katalogom); determinizam ostaje |
| 4 | **Preporuke: dostupnost i reload.** `exclude unavailable` važi i za preporuke; na reload-u se preporučivač dopunjuje, a događaji se ponovo čitaju. | 82, 98 | reload daje isto što i preporučivač napravljen iz nule (test kao `tests/reload.test.ts`) |
| 5 | **Pad semantičkog provajdera.** Kada embedding API ne odgovori, upit ide leksički i odgovor to prijavljuje kroz `vectorMode`, umesto greške. Samo ako plan to dozvoli. | 85, 184, 438 | test sa ugašenim provajderom |
| 6 | **OpenAPI ugovor.** `openapi.json` u repou. Osnova za Vue, Python i ostale klijente. | 361, 362, 381 | test pada kada se ugovor i odgovori servera razmimoiđu |
| 7 | **Fuzz parsera i `where` gramatike.** | 233, 310 | hiljade nasumičnih ulaza sa fiksnim seed-om: nikad izuzetak mimo dijagnostike, nikad SQL sa literalom van vezanih parametara |
| 8 | **Objava paketa.** npm za CLI i runtime, Packagist za PHP SDK. Danas se instalira kloniranjem repoa. | 354, 411 | `npm install gosimple-lang` i `composer require` rade; traži Ivanove naloge |

## 3. v0.4: poslovna pravila i povratna sprega

| Stavka | Vizija | Granica koja se ne pomera |
|---|---|---|
| **`policy {}` blok:** pojačanja kategorija, obavezni uslovi, pravila sa rokom važenja, sponzorisani rezultati | koncept 2; 114, 122 | pravilo ne sme da probije `protect intent` ni obavezan filter, i kompajler to proverava; sponzorisano je uvek označeno u odgovoru |
| **Događaji povratne sprege sa atribucijom:** prikaz, klik, pozicija, verzija plana | koncept 4; 161, 163 | zaštita od pozicione pristrasnosti i duplih događaja; pseudonimni ID-jevi i rok čuvanja (poglavlje XII) |
| **Merenje na živom prometu:** A/B dodela, kontrolna grupa, statistička značajnost | 460 do 465 | tek kada postoje događaji iz prethodne stavke |
| **Više engine-a po fajlu i `import`** | 10; `GS2016` | jedan plan i dalje ima jedan izvor istine |

## 4. Sva poglavlja vizije

Kratko stanje po poglavlju. Brojevi su stavke iz vizije.

| Poglavlje | Danas | Sledeće |
|---|---|---|
| **I. Jezik (1 do 18)** | **Postoji:** gramatika, leksika sa Unicode identifikatorima, AST, semantička provera. | `import` i moduli: **v0.4**. Verzija sintakse i pravila migracije: **P1**, sa prvom izmenom koja nije unazad kompatibilna. Funkcije, generici, async: **Ne radimo** (vidi §5). |
| **II. Kompajler i IR (19 do 38)** | **Postoji:** validacija, semantička analiza, tipizovan i verzionisan IR, determinizam, dijagnostike sa pozicijom i predlogom najbližeg imena. | `gs check --strict` (upozorenja kao greške): **P1**. WebAssembly: **P2**. Nativni backend: **Ne radimo**. |
| **III. Runtime (39 do 58)** | **Postoji:** izvršavanje IR-a, timeout 5 s, limiti, uredno gašenje na SIGTERM, `/health`, istovremeni reload deli jedno učitavanje. | Redovi poslova, retry, readiness odvojen od health: **P1**. |
| **IV. Pretraga (59 do 85)** | **Postoji:** reči, normalizacija, ćirilica i latinica, korenovanje, `where` na izvoru, semantika, hibrid, inkrementalni indeks, pitanje kod dvosmislenosti. | Filteri i stranice: **v0.3**. Tolerancija na greške u kucanju (uz test da ne kvari zaštitu namere), faseti, autocomplete: **P1**. Geo, federacija, ANN indeks: **P2**. |
| **V. Preporuke (86 do 110)** | **Postoji:** popularnost, sadržaj, ko-pojavljivanje sa kosinusnom normalizacijom, cold start, sezona prigušena afinitetom, cena, „slično ovome”, `explore`, već viđeno, odbijanja. | Dostupnost i reload: **v0.3**. Sesijske preporuke, cold start novog artikla: **P1**. Bandit algoritmi: **P2**. |
| **VI. Rangiranje (111 do 130)** | **Postoji:** težinski skor u `[0, 1]`, spajanje leksičkog i semantičkog, svežina, normalizovana popularnost, diverzifikacija, objašnjenje, deterministično presuđivanje, offline poređenje verzija. | Poslovna pravila i sponzorisano: **v0.4**. Fer izloženost: **P1**. Learning to rank: **P2**. |
| **VII. Sadržaj (131 do 152)** | **Postoji:** duplikati i parafraze (Žakar nad šinglovima), kvalitet, prisustvo specifikacija, prazne fraze, pouzdanost i dokazi. Nikad presuda o autorstvu, i to je testirano. | Doslednost naslova i opisa, prepoznavanje jezika: **P1**. OCR, NER, teme: **P2**. |
| **VIII. Podaci (153 do 174)** | **Postoji:** mapiranje kolona, JSON i PostgreSQL, konverzija tipova, allowlista identifikatora. | MySQL: **v0.3**. Ugovor podataka (izvor koji promeni tip polja pada glasno pri učitavanju), REST izvor: **P1**. CDC: **P2**. |
| **IX. AI runtime (175 do 196)** | **Postoji:** interfejs za embeddinge, OpenAI-kompatibilan adapter (radi i sa lokalnim Ollama modelom), pošten `vectorMode`. | Pad na leksičko: **v0.3**. Reranker, praćenje troška: **P1**. RAG, ruter modela: **P2**. |
| **X. Graf znanja (197 do 210)** | **Delimično:** item-item ko-pojavljivanje je implicitni graf. | **P2**, nad PostgreSQL tabelama, kako i vizija predlaže. |
| **XI. Bezbednost (211 do 240)** | **Postoji:** model pretnji, `where` gramatika sa testom pravog napada, kredencijali iz okruženja, redakcija, Bearer sa konstantnim vremenom, CORS zatvoren, samo `127.0.0.1`, nula zavisnosti, prijava ranjivosti. | Fuzz: **v0.3**. SBOM, potpisana izdanja: **P1**. Nezavisni pen test: **P2**. |
| **XII. Privatnost (241 do 260)** | **Postoji:** runtime ne čuva korisnike između zahteva, pa većina obaveza ostaje u aplikaciji domaćinu. | Postaje stvarno sa događajima u **v0.4**: pseudonimni ID-jevi, rok čuvanja, brisanje na zahtev. |
| **XIII. Vidljivost (261 do 280)** | **Delimično:** objašnjenje svakog rezultata, trajanje zahteva, `/health`, greške na stderr. | Strukturisani logovi, ID zahteva, metrike, OpenTelemetry kao opcioni peer: **P1**. |
| **XIV. Performanse (281 do 305)** | **Postoji:** `npm run benchmark` do 100 000 proizvoda, podizanje i p50/p95/p99 odvojeno, memorija. | Kapija za regresiju performansi u CI-ju, test zasićenja: **P1**. |
| **XV. Testiranje (306 do 335)** | **Postoji:** jedinični, integracioni sa živom bazom, HTTP, zlatni skup, negativni za nevažeći kod, brzi put protiv sporog, nasumične operacije, bezbednosne invarijante, determinizam. | Fuzz: **v0.3**. Mutaciono testiranje: **P1**. |
| **XVI. Iskustvo programera (336 do 360)** | **Postoji:** CLI, dijagnostike koje kažu šta, gde, zašto i kako da se ispravi. | VS Code isticanje sintakse, zatim LSP i formatter: **P1**. Playground: **P2**. |
| **XVII. API i SDK (361 do 385)** | **Postoji:** HTTP API, PHP SDK sa Laravel provajderom, TS SDK sa prekidom kroz `AbortSignal`, Bearer, jedinstven oblik greške, limiti. | OpenAPI, stranice, PHP u CI-ju: **v0.3**. Python SDK iz OpenAPI-ja, primer aplikacije za Laravel i Next: **P1**. |
| **XVIII. Paketi (386 do 405)** | Ne postoji. | Objava na npm i Packagist: **v0.3**. Sopstveni registar: **P2**, tek posle `import`. |
| **XIX. Izdanja (406 do 430)** | **Postoji:** CI na Ubuntu, macOS i Windows, Node 22.18 i 24; tag i beleške za svako izdanje; konfiguracija i tajne kroz okruženje. | Kontejner, SBOM, potpis: **P1**. |
| **XX. Pouzdanost (431 do 455)** | **Delimično:** timeout, limit zahteva, uredno gašenje. Pad embedding servisa danas obara upit. | Pad na leksičko: **v0.3**. Circuit breaker za provajdera: **P1**. |
| **XXI. Eksperimenti (456 do 480)** | **Postoji offline:** zlatni skup, verzionisan kroz git, CI kapija za regresiju zaštite namere. | Online merenje: **v0.4**. Drift modela: **P2**. |
| **XXII. Multimodalno (481 do 500)** | Samo tekst. | **P2**. Vizija sama kaže: interfejsi, ne sopstveni modeli. |
| **XXIII. Evolucija jezika (501 do 520)** | **Postoji:** verzija IR-a i pravila kompatibilnosti u `SPEC.md` §5. | Zapisi arhitektonskih odluka (`docs/adr/`), korpus programa koji mora da se kompajlira kroz izdanja: **P1**. |
| **XXIV. Upravljanje projektom (521 do 540)** | **Postoji:** Apache-2.0 sa `NOTICE`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`, ovaj dokument. | RFC proces za izmene jezika, `SUPPORT.md`: **P1**. Jedan održavalac je stvaran rizik (539). |
| **XXV. Dokumentacija (541 do 560)** | **Postoji:** specifikacija, README sa Laravel i Next primerima, bezbednosni model, merenja, CHANGELOG. | Vodič za puštanje u rad, zbirka recepata: **P1**. |
| **XXVI. Poslovna analitika (561 do 580)** | **Delimično:** objašnjiv rezultat, kvalitet sadržaja po dokumentu kroz `gs content`. | Upiti bez rezultata, levak konverzije: posle događaja iz **v0.4**. |
| **XXVII. Jezici i lokalni kontekst (581 do 600)** | **Postoji:** Unicode normalizacija, ćirilica i latinica kao isto, dijakritici, srpsko korenovanje, srpske množine. Sezone su meteorološke, za severnu hemisferu. | Engleski korenovanje i dijagnostike na engleskom, kalendar praznika: **P1**. |
| **XXVIII. Više klijenata (601 do 620)** | Ne postoji: jedan proces služi jedan plan i jedan katalog. Izolacija danas je proces po klijentu. | **P2**. |
| **XXIX. Standardi (621 do 635)** | **Postoji:** HTTP i JSON, standardni SQL drajver, ISO datumi. | OpenAPI: **v0.3**. JSON Schema za zlatni skup i IR, OpenTelemetry: **P1**. |
| **XXX. Spremnost izdanja (636 do 655)** | Vidi §6. | |

Koncepti iz vizije koji nisu u numerisanim poglavljima:

| Koncept | Stanje |
|---|---|
| Intent Engine, uključujući pitanje kada je namera nejasna | **Postoji** (`SPEC.md` §3.2) |
| Policy Engine | **v0.4** |
| Knowledge Engine | **P2** |
| Feedback Engine | **v0.4** |
| Evaluation Engine | **Postoji** kao `gs eval` (vidi §1) |
| Data Contracts | **P1** |
| Privatnost kao deo jezika | **v0.4**, zajedno sa događajima |
| Edge i lokalni runtime | Lokalni **postoji** (sve radi bez mreže). Edge i WebAssembly: **P2** |
| AI agenti kao korisnici | **P1**: MCP server iznad postojećeg HTTP API-ja, sa istim limitima |
| Cost Intelligence | **P2**; danas jedini plaćeni poziv je embedding u `semantic` režimu |
| Autopilot | **P2**, i samo kao predlog; nikad samostalna izmena produkcijskih pravila |

## 5. Šta svesno ne radimo

| Odluka | Razlog |
|---|---|
| **Opšti programski jezik:** funkcije, generici, petlje, async (vizija 7, 8, 12) | GoSimple je deklarativan. Svaka od tih konstrukcija vodi ka izvršavanju proizvoljnog koda u runtime-u, a to ruši pravilo da se plan čita sa diska i da se ništa iz ulaza ne izvršava. Vraćamo se na ovo samo uz stvaran slučaj koji deklarativni oblik ne može da izrazi. |
| **Prepis u Rust** (vizija predlaže Rust za kompajler i runtime) | Svesno odstupanje. Usko grlo je bilo u algoritmu (dva kvadratna koraka), ne u jeziku implementacije, i otklonjeno je merenjem. Prepis dolazi samo ako benchmark pokaže da TypeScript više ne može da drži cilj, i tada ide kao zapis odluke sa brojevima. |
| **Nativni i LLVM backend** (vizija 29) | Runtime tumači IR, a vreme odlazi na indeks i skorove, ne na tumačenje. |
| **Sopstveni kompajler za PHP ili JavaScript** | Vizija je ovde u pravu: integracija ide preko HTTP-a i SDK-ova. |
| **Presuda „ovo je napisao AI”** | Tekst ne nosi dovoljno dokaza. Sadržajni modul daje osobine teksta i pouzdanost, nikad tvrdnju o autorstvu, i to je zaštićeno testom. |
| **Kompajliranje `.gs` iz mreže** | Ni za playground nad pravim izvorom. Plan se kompajlira jednom, sa diska. |

## 6. v0.2.0 prema kontrolnoj listi izdanja (vizija XXX)

| Stavka | v0.2.0 |
|---|---|
| 636 Specifikacija verzionisana | da, `SPEC.md` v0.2 |
| 637 Kompajler prati specifikaciju | da, `tests/docs.test.ts` traži da svaki kod iz koda postoji u `SPEC.md` |
| 638 Obavezni testovi prolaze | da, 241 test, 8 CI poslova zeleno na `51ceb85` |
| 639 Benchmark pretrage | da, ručno; nije kapija u CI-ju |
| 640 Pragovi za ocenu preporuka | **ne**: zlatni skup pokriva samo pretragu |
| 641 Model pretnji pregledan | da, `SECURITY.md` |
| 642 Kritične ranjivosti zatvorene | nema poznatih |
| 643 Zavisnosti evidentirane | da, nula runtime zavisnosti, provereno u CI-ju |
| 644 Testovi kompatibilnosti SDK-ova | **delimično**: PHP SDK proveren ručno protiv živog servera, ne u CI-ju |
| 645, 646 Migracije, rezervne kopije | ne primenjuje se: runtime ne čuva stanje |
| 647 Nadzor i uzbune | **ne** |
| 648 Dokumentacija instalacije | da |
| 649 Licenca | da, Apache-2.0 |
| 650 Proverljivo poreklo artefakata | **ne**: izdanja nisu potpisana |
| 651 Ograničenja javno navedena | da, README i CHANGELOG |
| 652 Postupak za incidente | delimično: prijava ranjivosti u `SECURITY.md` |
| 653 Testirano u reprezentativnom okruženju | delimično: tri operativna sistema i živa baza u CI-ju |
| 654 Plan održavanja | ovaj dokument |
| 655 Kriterijum za povlačenje izdanja | **ne** |

Rupe iz ove tabele su ulaz za naredna izdanja: 644 je v0.3, 640, 647, 650 i
655 su P1.
