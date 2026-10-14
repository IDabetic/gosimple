# Bezbednosni model GoSimple-a

## Osnovna napomena

Nijedan softver se ne može proglasiti bezbednim bez ranjivosti, i ovaj dokument to ne tvrdi. Ono što se može tvrditi i proveriti jeste da je napadna površina mala, da su kontrole imenovane, i da svaka od njih ima test.

## Najvažnija arhitektonska odluka

**Runtime nikada ne kompajlira program iz mrežnog zahteva.**

`.gs` fajl se kompajlira jednom, pri pokretanju, sa diska. Ne postoji putanja od HTTP ulaza do leksera, parsera ili kompajlera. Time cela klasa napada „napadač šalje zlonameran program" ne postoji, umesto da se ublažava sandboxom koji može da pukne.

Posledica za vas: `.gs` fajlovi se tretiraju kao izvorni kod, ne kao korisnički unos. Idu u git, prolaze code review i deploy kao i svaki drugi kod.

## Šta je stvarno implementirano

| Kontrola | Gde | Vrednost |
|---|---|---|
| Ograničenje veličine tela | `server.ts` | 64 KB, socket se prekida pri prekoračenju |
| Ograničenje dužine upita | `server.ts` | 512 znakova |
| Ograničenje nizova | `server.ts` | 32 interesovanja, 500 viđenih ID-jeva |
| Timeout zahteva | `server.ts` | 5 s na socketu, zaglavljima i zahtevu |
| Rate limiting | `server.ts` | 300 zahteva u minutu po klijentu, sa čišćenjem mape |
| Bearer autentikacija | `server.ts` | poređenje u konstantnom vremenu |
| CORS | `server.ts` | zatvoren po podrazumevanom; otvara se samo kroz `GOSIMPLE_CORS_ORIGINS` |
| Vezivanje za loopback | `server.ts` | sluša na `127.0.0.1`, ne na `0.0.0.0` |
| Validacija ulaza | `server.ts` | eksplicitna provera tipa i opsega za svako polje |
| Sanacija grešaka | `server.ts` | interne greške se loguju, klijent dobija samo generičku poruku |
| Provera verzije IR-a | `execute.ts` | plan nepoznate verzije se odbija umesto da se nagađa |
| Gramatika `where` uslova | `sources/where.ts` | uslov se parsira i SQL se ponovo sastavlja; literali odlaze kao vezani parametri |
| Provera SQL identifikatora | `sources/index.ts` | allowlista `^[A-Za-z_][A-Za-z0-9_]*$`, provereno pri kompajliranju i ponovo pri sastavljanju upita |
| Redakcija putanja i kredencijala | `sources/index.ts` | `/health` prikazuje ime fajla ili host, nikada punu putanju ni lozinku |
| Reload čita samo svoj izvor | `server.ts` | `POST /reload` odbija telo zahteva, zahteva Bearer token, nikada ne prima katalog preko mreže |

## Ispravljena ranjivost: injekcija kroz `where` uslov

Ovo stoji ovde zato što je bila stvarna, a ne hipotetička.

Prva verzija je `where` uslov proveravala odbacivanjem `;`, `--` i `/*`, i ta kontrola je bila **dokumentovana kao bezbednosna**. Bila je blok-lista, i pala je na prvom ulazu koji te znakove ne koristi:

```
where "false UNION SELECT username, password_hash, category_slug FROM users"
```

Nadovezano na `SELECT`, to vraća sadržaj tabele `users` kao da su proizvodi. Reprodukovano je protiv žive PostgreSQL instance i izvuklo hešove lozinki.

**Ispravka.** `where` se više nikada ne nadovezuje. Parsira se u stablo izraza koje ume da izrazi samo filtriranje redova, a SQL se sastavlja iz tog stabla: identifikatori se proveravaju i stavljaju pod navodnike, svaki literal odlazi kao vezani parametar. Podupiti, `UNION`, pozivi funkcija i kastovi su greška pri kompajliranju (`GS2042`), sa pozicijom u uslovu.

**Zašto je ovo trajnije.** Blok-lista brani od primera, allowlista od gramatike. Ono što gramatika ne ume da predstavi ne može ni da se desi, pa sledeća tehnika koja nikome nije pala na pamet nema kuda da uđe.

Napad se izvršava protiv prave baze pri svakom CI pokretanju (`tests/postgres.integration.test.ts`), zajedno sa dokazom da tabela `users` u tom trenutku zaista sadrži podatke — da test ne bi prolazio zato što nema šta da procuri.

## Granice poverenja

```
[ .gs fajl ]  — poverljiv izvorni kod, prolazi code review
      ↓ kompajlira se pri pokretanju
[ IR plan  ]  — verzionisan, validiran, nepromenljiv u toku rada
      ↓
[ runtime  ]  — nema pristup fajlovima niti mreži tokom obrade upita
      ↑
[ HTTP ulaz ] — nepoverljiv, validira se u celosti pre nego što dođe do runtime-a
```

Runtime tokom obrade upita ne otvara fajlove, ne šalje mrežne zahteve i ne izvršava ništa iz ulaza. Katalog se učitava iz izvora pri pokretanju, i ponovo samo na `POST /reload` — koji ne prima dokumente iz zahteva, nego čita isti izvor. Bez `GOSIMPLE_TOKEN` ta putanja ne postoji.

## Poznata ograničenja ove verzije

Navodim ih eksplicitno jer su realna:

1. **Rate limiter je u memoriji i po procesu.** Iza load balancera sa više instanci limit se množi brojem instanci. Za produkciju iza proxyja koristite rate limiting na proxyju.
2. **Identifikacija klijenta ide po `remoteAddress`.** Ako radite iza reverse proxyja, svi zahtevi deluju kao da dolaze sa jedne adrese. `X-Forwarded-For` se namerno **ne** čita, jer je taj zaglavlje falsifikovano kad proxy nije pouzdan.
3. **Nema TLS-a.** Runtime je predviđen da radi na loopbacku iza proxyja koji terminira TLS.
4. **Nema multi-tenant izolacije.** Jedan proces služi jedan plan i jedan katalog.
5. **Katalog se učitava u memoriju u celosti.** Za velike kataloge je potreban indeksni adapter, koji v0.1 nema.
6. **Nema audit loga.** Postoji samo logovanje grešaka na stderr.
7. **`.gs` fajl ima punu moć nad konfigurisanim izvorom.** Gramatika `where` uslova sprečava čitanje drugih tabela, ali `table` i `map` i dalje biraju šta se čita iz baze. Ko piše `.gs` fajl, bira i podatke — zato se tretira kao izvorni kod, a ne kao konfiguracija koju sme da menja bilo ko.
8. **Nalog za bazu treba da bude samo za čitanje.** Runtime nikada ne izvršava `INSERT`, `UPDATE` ni `DELETE`, pa nalog kom su te dozvole date daje više nego što je potrebno. To je odbrana u dubinu, a ne zamena za gornje kontrole.

## Privatnost

Runtime ne upisuje ništa na disk i ne čuva `user.id`, `interests` ni `seenIds` između zahteva. Podaci korisnika žive samo za trajanje jednog upita. Ako dodate perzistenciju, obaveze oko zaštite podataka o ličnosti postaju vaše i treba ih proceniti posebno.

## Prijava ranjivosti

Ne otvarajte javni issue za bezbednosni problem. Pošaljite opis, korake za reprodukciju i procenu uticaja održavaocu projekta. Cilj je potvrda prijema u roku od 72 sata i ispravka ili plan ispravke u roku od 30 dana za potvrđene ranjivosti.

## Pre nego što ovo pustite u produkciju

- [ ] Postavite `GOSIMPLE_TOKEN`
- [ ] Postavite `GOSIMPLE_CORS_ORIGINS` na konkretne domene, nikada na `*`
- [ ] Stavite runtime iza reverse proxyja sa TLS-om i sopstvenim rate limitom
- [ ] Ne izlažite port 7777 javno
- [ ] Pokrenite `npm test` i `npm run typecheck` u CI-ju
- [ ] Zaključajte verzije zavisnosti i uključite skeniranje ranjivosti
- [ ] Za SQL izvore napravite zaseban nalog sa pravom samo na `SELECT` nad tabelom koja se koristi
- [ ] Pokrenite integracione testove protiv svoje baze: `GOSIMPLE_TEST_PG=... npm test`
