import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildDuplicationScores,
  buildDuplicationScoresNaive,
  shingles,
} from '../src/runtime/duplication.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('indeks duplikata daje isto što i poređenje svih sa svima', () => {
  /**
   * Brzi put vredi tačno onoliko koliko se slaže sa sporim. Ako se ova
   * tvrdnja ikada pokvari, optimizacija je počela da menja rezultate, što je
   * gore od toga da je spora.
   */
  function agrees(texts: string[], message: string): void {
    const fast = buildDuplicationScores(texts);
    const naive = buildDuplicationScoresNaive(texts);

    for (let i = 0; i < texts.length; i++) {
      assert.ok(
        Math.abs(fast[i]! - naive[i]!) < 1e-9,
        `${message}: dokument ${i} — indeks ${fast[i]}, poređenje svih ${naive[i]}`,
      );
    }
  }

  test('nepovezani tekstovi', () => {
    agrees(
      [
        'Iridijumske svećice za benzinske motore, razmak elektroda 1.1 mm.',
        'Frižider sa dve komore, energetska klasa A, zapremina 320 litara.',
        'Akumulatorska bušilica 18 V sa dve baterije i koferom.',
      ],
      'nepovezani',
    );
  });

  test('identični tekstovi', () => {
    const filler = 'Savršen izbor za vaš dom. Vrhunski kvalitet po najpovoljnijoj ceni.';
    agrees([filler, filler, filler, 'Nešto sasvim drugo o bušilicama i alatu.'], 'identični');
  });

  test('delimično preklapanje', () => {
    agrees(
      [
        'Solarne baštenske svećice LED sa treperavim plamenom, visina 38 cm.',
        'Solarne baštenske svećice LED sa treperavim plamenom, visina 52 cm.',
        'Solarna baštenska svetiljka za stazu sa senzorom pokreta.',
      ],
      'delimično',
    );
  });

  test('jedan tekst nema sa čim da se poredi', () => {
    assert.deepEqual(buildDuplicationScores(['usamljen tekst']), [0]);
  });

  test('prazan korpus', () => {
    assert.deepEqual(buildDuplicationScores([]), []);
  });

  test('prazni tekstovi ne ruše indeks', () => {
    agrees(['', '', 'Nešto napisano ovde o proizvodu.'], 'prazni');
  });

  test('tekst kraći od šingla', () => {
    // Manje od četiri reči ne daje nijedan šingl, pa nema ni preklapanja.
    agrees(['dve reči', 'dve reči', 'tri cele reči ovde'], 'kratki');
  });

  test('slaganje nad stvarnim katalogom iz primera', () => {
    const catalog = JSON.parse(
      execFileSync('cat', [join(root, 'examples', 'catalog.json')], { encoding: 'utf8' }),
    ) as Array<{ description?: string; title: string }>;

    agrees(
      catalog.map((d) => d.description ?? d.title),
      'examples/catalog.json',
    );
  });

  test('slaganje nad sintetičkim katalogom od 400 proizvoda', () => {
    // Generator pravi klastere identičnog marketinškog teksta, što je
    // upravo slučaj koji indeks rešava posebnim putem.
    const docs = JSON.parse(
      execFileSync(process.execPath, [join(root, 'scripts', 'generate-catalog.mjs'), '400'], {
        encoding: 'utf8',
        maxBuffer: 1024 * 1024 * 64,
      }),
    ) as Array<{ description?: string; title: string }>;

    agrees(
      docs.map((d) => d.description ?? d.title),
      'sintetički katalog',
    );
  });
});

describe('ponašanje duplikacije', () => {
  test('identičan tekst daje tačno 1', () => {
    const text = 'Potpuno isti opis proizvoda u oba slučaja, reč po reč.';
    assert.deepEqual(buildDuplicationScores([text, text]), [1, 1]);
  });

  test('potpuno različit tekst daje 0', () => {
    const scores = buildDuplicationScores([
      'Kočione pločice prednje sa senzorom habanja debljine sedamnaest milimetara.',
      'Rerna ugradna električna zapremine šezdeset pet litara sa funkcijom pare.',
    ]);
    assert.deepEqual(scores, [0, 0]);
  });

  test('rezultat je u opsegu [0, 1]', () => {
    const docs = JSON.parse(
      execFileSync(process.execPath, [join(root, 'scripts', 'generate-catalog.mjs'), '200'], {
        encoding: 'utf8',
        maxBuffer: 1024 * 1024 * 64,
      }),
    ) as Array<{ description?: string; title: string }>;

    for (const score of buildDuplicationScores(docs.map((d) => d.description ?? d.title))) {
      assert.ok(score >= 0 && score <= 1, `rezultat van opsega: ${score}`);
    }
  });

  test('redosled dokumenata ne menja rezultate', () => {
    const texts = [
      'Prvi opis proizvoda sa nekoliko konkretnih podataka o dimenzijama.',
      'Drugi opis proizvoda sa nekoliko konkretnih podataka o dimenzijama.',
      'Treći, potpuno nepovezan tekst o alatu za radionicu.',
    ];

    const forward = buildDuplicationScores(texts);
    const reversed = buildDuplicationScores([...texts].reverse()).reverse();

    for (let i = 0; i < texts.length; i++) {
      assert.ok(Math.abs(forward[i]! - reversed[i]!) < 1e-9, `redosled je promenio rezultat na ${i}`);
    }
  });

  test('mali broj kandidata daje donju granicu, nikada veću vrednost', () => {
    // Pri namerno malom broju kandidata indeks sme da propusti par i time
    // potceni preklapanje, ali ne sme da ga preceni — lažno visoka
    // duplikacija bi kaznila pošten opis kao prepisan.
    const texts = [
      'Isti uvodni tekst o proizvodu. Dodatak jedan.',
      'Isti uvodni tekst o proizvodu. Dodatak dva.',
      'Isti uvodni tekst o proizvodu. Dodatak tri.',
    ];

    const exact = buildDuplicationScoresNaive(texts);
    const limited = buildDuplicationScores(texts, { candidateLimit: 1 });

    for (let i = 0; i < texts.length; i++) {
      assert.ok(limited[i]! <= exact[i]! + 1e-9, `indeks je precenio duplikaciju na ${i}`);
    }
  });
});

describe('šinglovi', () => {
  test('tekst kraći od veličine šingla ne daje nijedan', () => {
    assert.equal(shingles('jedna dve tri').size, 0);
  });

  test('četiri reči daju tačno jedan šingl', () => {
    assert.equal(shingles('jedna dve tri četiri').size, 1);
  });

  test('korenovanje spaja oblike iste reči', () => {
    // "svećice" i "svećica" moraju da daju isti šingl, inače bi dva opisa
    // koja se razlikuju samo po padežu prošla kao različita.
    const a = shingles('solarne svećice za baštu');
    const b = shingles('solarne svećica za baštu');
    assert.deepEqual([...a], [...b]);
  });
});
