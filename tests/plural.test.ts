import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { plural, pluralGreska, pluralKategorija, pluralUpozorenje } from '../src/plural.ts';

describe('srpska množina', () => {
  test('jednina se koristi samo za brojeve koji se završavaju na 1', () => {
    for (const n of [1, 21, 31, 101, 1001]) {
      assert.equal(pluralGreska(n), 'greška', `${n} greška`);
    }
  });

  test('paukal se koristi za 2–4 i njihove nastavke', () => {
    for (const n of [2, 3, 4, 22, 33, 104]) {
      assert.equal(pluralGreska(n), 'greške', `${n} greške`);
    }
  });

  test('množina se koristi za 5 i više', () => {
    for (const n of [0, 5, 9, 25, 100]) {
      assert.equal(pluralGreska(n), 'grešaka', `${n} grešaka`);
    }
  });

  test('11–14 su izuzetak uprkos poslednjoj cifri', () => {
    // Ovo je mesto gde naivna implementacija pukne: 11 se završava na 1,
    // a 12–14 na 2–4, pa bi bez izuzetka dali pogrešan oblik.
    for (const n of [11, 12, 13, 14, 111, 112, 1013]) {
      assert.equal(pluralGreska(n), 'grešaka', `${n} grešaka`);
    }
  });

  test('imenice ženskog roda na -a dobijaju isti obrazac', () => {
    assert.equal(pluralKategorija(1), 'kategorija');
    assert.equal(pluralKategorija(4), 'kategorije');
    assert.equal(pluralKategorija(5), 'kategorija');
  });

  test('imenice srednjeg roda dele paukal i množinu', () => {
    assert.equal(pluralUpozorenje(1), 'upozorenje');
    assert.equal(pluralUpozorenje(2), 'upozorenja');
    assert.equal(pluralUpozorenje(7), 'upozorenja');
  });

  test('negativni brojevi ne ruše izbor oblika', () => {
    assert.equal(plural(-1, 'a', 'b', 'c'), 'a');
    assert.equal(plural(-13, 'a', 'b', 'c'), 'c');
  });
});
