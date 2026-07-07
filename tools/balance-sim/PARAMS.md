# Параметры баланса: текущее vs кандидаты

Синхронизация: **2026-07-07 DONE (второй проход)** — все три скрипта тянут `data/*.json` напрямую (utf-8), включая:
- экспоненциальную цену рабочих `floor(5 × 1.05^E)`, `E = Σ 2^(level-1)` — приведено 1:1 с `reserveSystem.getUnitBuyCost`;
- 24 волны с `composition`, реальные `victoryGold + killGold × enemyCount` в награде;
- trait yield mul на добычу (приближение: `1 + level × YIELD_MUL` на доминантной линии);
- merge-based цена зданий в `difficulty.py`: Lv N = `2^(N-1) × buyCost` (без старой resource-based upgrade-лестницы).

Не смоделировано (см. TODO ниже): boss mechanics, attrition, capstones, top-building actives, wave demand multiplier.

Легенда: 🔴 подтверждённая проблема · 🟡 под вопросом · 🟢 рекомендуемая правка к прогону.

---

## 1. Экономика покупки юнитов (`data/balance.json` + `reserveSystem.js`)

| Параметр | Сейчас | Кандидат | Заметка |
|---|---|---|---|
| формула цены | 🟢 `floor(5 × 1.05^E)`, `E = Σ 2^(ур−1)` (live) | 🟢 подтверждено — sim совпадает 1:1 с `reserveSystem` |
| `unitBuyBaseCost` | 5 | 5 | |
| `unitBuyExponent` | 1.05 (не используется) | 🟢 1.05 (подключить); проверить 1.04–1.08 | выше → жёстче потолок ростера, сильнее давит на мерж |
| `startingGold` | 65 | 65 | |
| `startingResources` | wood 70, ore 35 | пересмотреть под старт 20-волнового лупа | |
| `merge.maxLevel` | 5 | 5 (растёт пиками до 7) | L5+ сейчас недостижимы по золоту |

## 2. Волны (`data/fortress-waves.json`)

Сейчас **7 волн**, награда размазана, тайм-гейты огромные. Всего золота ≈ **636**.

| | Сейчас | Кандидат |
|---|---|---|
| число волн | 7 | 🟢 20–24, босс каждые 5 |
| `victoryGold` | 12→64 (крупные редкие) | 🟢 `≈ 14 + 4×волна` (мелкие частые), кумулятив ~1120–1400 |
| `killGold` | 3→6 | мелкий, синхронно |
| `enemyCount` | 4→24 за 7 шагов | плавный разгон 4→~40 за 20–24 волны |
| `spawnIntervalSeconds` | 1.15→0.55 | плавно |

Enemy-скейл (в коде `createFortressEnemy`): `hp = 28 + 3×(волна−1)`,
`attack = 10 + ⌊(волна−1)/3⌋`. Под 20+ волн пересчитать, чтобы не улетел.

## 3. Добыча (`data/mine-levels.json`)

| Параметр | Сейчас | Кандидат |
|---|---|---|
| `workerProductionByLevel` | 6/13/28/60/126/255/510 (за 4с) | 🟢 сделать круче по уровням (мерж сильнее концентрирует) — тюнить под §6 |
| `collectionIntervalSeconds` | 4 | 4 |
| слоты (levels) | 1→5 через `mineSlot`-пики | 🟢 **держать СКУДНЫМИ** и дорогими — фундамент против «батареек» |
| gold из шахт | 0 (`goldPerSecondPerWorkerLevel`, `passiveGoldPerSecondPerUnlockedMine` = 0) | 🟡 капель отложена; золото из добычи — через трейт-капстоун «Меняла» (§6) |

## 4. Здания (`data/fortress-buildings.json`)

🔴 Стоимость апгрейдов растёт ~геометрически и **обгоняет добычу в ~10× на волнах 5–7** →
стойла 300–600с. Максовое здание = 1000–2500 ед. ресурса; вся добыча за игру этого не тянет.

| | Сейчас | Кандидат |
|---|---|---|
| кривая цены | задана вручную, не связана с добычей | 🟢 калибровать ОТ добычи (`COST_SCALE` в `pacing_v2.py`, старт S≈12) |
| реген HP зданий | бесплатно на фулл между волнами | 🟢 убрать → аттриция + ремонт за ресурсы (§5 плана) |
| прокачка | за ресурсы | 🟢 своп → через **мерж** двух одинаковых зданий |
| ремонт | нет | 🟢 за ресурсы, инкрементально (не death-spiral) |
| турель damage L1/L2/L3 | 10/17/26 | ключевой порог боя — L3 турели решают волны 6–7 |

## 5. Рекомендуемая цена построек (кандидат из `pacing_v2.py`, `cost(w)`)

Кумулятивная цель вложений, `ramp(scale, start, g=1.16) = scale × COST_SCALE × 1.16^(w−start)`,
`COST_SCALE = 12`. Новые ресурсы разгоняются с нуля, шахта открыта за ~2 волны до спроса:

| Ресурс | scale | стартовая волна спроса | шахта открыта |
|---|---|---|---|
| wood | 90 | 1 | старт |
| ore | 70 | 2 | старт |
| iron | 60 | 5 | волна 3 |
| crystal | 45 | 10 | волна 8 |

Результат прогона (S=12): total 13.8 мин, prep 10–115с, avg 41с, **0 стойл >2мин**.
Для ~22–25 мин: 24 волны и/или S≈14.

---

## Новые поля (не смоделированы в этом проходе)

| Механика | Статус | TODO |
|---|---|---|
| `attrition` (floorPerDefeat, repairCost) | не смоделирована | требует рефакта Econ с ремонтом за ресурсы |
| `capstones` (Yield/Golden/Rush, гибриды) | не смоделирована | требует трейт-систему в рабочих |
| `fortressBuildings[].active` (турель/казарма/стена) | не смоделирована | опциональна, late-game |
| `boss mechanics` (aura, breach) | stub | TODO: orcKing aura тик, breacher × dmg vs buildings |
| `necromancer summon` | TODO | сложна для симуляции, требует дополнительного кода |

## Что прогнать завтра первым делом

1. `python pacing_v2.py` — проверить 24-волновый луп на новых данных, поиграть `COST_SCALE`.
2. `python difficulty.py` — кривая нужной силы на 24 волнах + новых врагов (grunt/runner/armored/archerE).
3. После внедрения трейтов шахтёров (§6 плана) — пересчитать производство и переогонить `COST_SCALE`.
4. **Не финализировать числа** до системы шахтёров — кривая добычи изменится.

---

## Аудит sim ↔ игра (2026-07-07, третий проход, ПЕРЕД калибровкой)

Прошёл по коду и данным: перечислил все живые механики/ручки и отметил, что моделируется симами, а что нет. Это **план разработки симов на следующий проход**, до запуска калибровки.

### Легенда
✅ смоделировано корректно · 🟡 приблизительно/устарело · ❌ не смоделировано · 💤 в игре есть, но выключено нулём (моделировать не нужно, пока не включат)

### Матрица покрытия

| Механика / ручка | Источник | pacing_v2 | econ_timing | battle_sim | difficulty |
|---|---|---|---|---|---|
| `unitBuyBaseCost`, `unitBuyExponent`, `E=Σ2^(lvl-1)` | balance.json + reserveSystem | ✅ | ✅ | — | — |
| `startingGold`, `startingResources` | balance.json | ✅ | ✅ | — | — |
| `merge.maxLevel` = 5 | balance.json | 🟡 hardcoded 5, но динамически растёт `merge_cap<7` — так в игре НЕ бывает | ✅ MERGE_MAX | — | — |
| Trait Yield (`resourceMultiplierPerPoint`) | balance.json + workerTraitSystem | 🟡 аппроксимация `1+lvl×perPoint` (не отражает реальный вектор трейтов) | 🟡 та же аппроксимация | — | — |
| Trait Golden (`goldPerResourcePerPoint`) → капель золота из добычи | workerTraitSystem | ❌ (модель говорит «gold ONLY from battle») | ❌ (та же оговорка) | — | — |
| Trait Rush (`battleMultiplierPerPoint`) + `battleShift.baseMultiplier` × слот при committed | workerTraitSystem, mineSystem | ❌ | ❌ | — | — |
| `battleShift.maxCommitsPerMine` = 2, rest-flag | mineSystem | ❌ | ❌ | — | — |
| Capstones (yieldMul, demandMul, goldenConversion, passiveGold, rushBonus, battleDamageBonus, foreman, warlord) | workerTraitSystem | ❌ | ❌ | ❌ (battleDamageBonus у смены) | — |
| `waveDemand.slotProductionMultiplier` × слот подсвеченной шахты | mineSystem + waves.demandResource | ❌ | 🟡 читается, но не применяется в `prod()` | — | — |
| `productionMultipliers.battle` = 1.5 (добыча во время боя) | mineSystem | ❌ (prep — вне боя, battle-множитель применяется только на длительность боя, не учитывается) | ❌ | — | — |
| `productionMultipliers.rest` = 1 | balance.json | ✅ (тривиально) | ✅ | — | — |
| Reward draft (permanent/temporary/oneShot) — 15% goldGain, +12 baseHp, +25% production, +20% damage, ремонт-всё, injection и т.д. | upgradeSystem, balance.json | ❌ (только фиксированная награда `14+4w`, читает `wave.victoryGold` только косвенно) | ⚠️ читает `victoryGold+killGold×enemyCount`, но игрок не делает pick | ❌ | ❌ |
| Wave `startBonusGold` × линейный decay от `startBonusWindowSeconds` (early-start бонус) | fortress-waves.json, fortressBattleSystem | ❌ **новая механика, добавить** | ❌ | — | — |
| Wave `composition` (архетипы), 24 волны, boss каждые 5 | fortress-waves.json | ✅ (через `len(waves_data)`) | ✅ | ✅ (парсит composition) | ✅ |
| Enemy wave scaling: `hp += 3×(w−1)`, `attack += (w−1)//3` | fortressBattleSystem.createFortressEnemy | — | — | 🟡 attack scaling `(w−1)//2` — **MISMATCH** (в игре `//3`) | 🟡 |
| Boss `orcKing` aura (DPS в радиусе) | fortress-enemies.json + tickBossMechanic | — | — | ❌ (комментарий-TODO в конце файла) | ❌ |
| Boss `necromancer` summon (каждые N сек) | tickBossMechanic | — | — | ❌ | ❌ |
| Boss `breacher` `damageMultVsBuildings` (×3 по зданиям) | fortressBattleSystem.tickEnemies (inline) | — | — | ❌ | ❌ |
| Building `unlockWave`, `unlockedByDefault` | fortress-buildings.json + fortressSystem | ❌ | ❌ | — | ❌ (ladder игнорирует лок волн) |
| Building **merge-upgrade** (Lv N = 2×Lv N−1, обнуляет damageFloor) — единственный путь прокачки игроком | fortressSystem.mergeFortressBuildings | — | — | ✅ (Building.hp правильно) | ✅ `cost_of` = 2^(L−1) |
| Building `upgradeCost` в данных — **используется ТОЛЬКО reward-draft карточкой** (upgradeFortressBuilding), не в UI | fortress-buildings.json | — | — | — | ❌ (сим считает merge-only, но карточка добавляет бесплатные апгрейды) |
| Repair (per HP × `repairCostPerHpFractionOfBuyCost`) | fortressSystem.repairFortressBuilding | ❌ (нет второго стока ресурсов) | ❌ | — | — |
| **Аттриция (новая):** `damageFloor += floorPerDefeat` кумулятивно; после defeat hp = maxHp × max(0, postDefeatHpFraction − damageFloor); victory/ремонт → floor=0, hp=maxHp | fortressBattleSystem.finishBattle, fortressSystem.repairFortressBuilding | ❌ (сим предполагает, что игрок всегда побеждает — attrition не давит) | ❌ | ❌ (battle_sim бросает `b.hp = b.maxHp` в старте — забывает damageFloor) | ❌ (обороны стартуют full HP каждую волну) |
| Building actives (buildingDamageBoost/spawnSquad/volley/frost/shield) | fortressSystem.triggerBuildingActive + battle-помощь | — | — | ❌ (нет ни ветки) | ❌ |
| `shieldRemaining`/`shieldReduction` (снижение урона по зданию под щитом) | fortressBattleSystem.tickEnemies | — | — | ❌ | ❌ |
| Fortress damage/defense/gold multipliers (из reward-draft) | upgradeSystem.getFortress\*Multiplier | — | — | ❌ (не читает `state.economy`) | ❌ |
| `passiveGold*` (per-second, per-mine) — сейчас 0 | balance.json | 💤 | 💤 | — | — |
| `obstacleRemovalCost` (нарастающий сток на клетки) | fortressSystem.removeFortressObstacle | ❌ (сим полагает поле пустым) | ❌ | — | — |
| `startingOre` legacy override | balance.json | 💤 (0) | 💤 | — | — |

### Ключевые последствия для калибровки (что чинить в симах ДО прогона)

Порядок — от самого влиятельного на прогноз:

1. **`battle_sim.py` scaling врагов: `attack += (wave-1)//2` → `//3`** (единственный чистый баг-порт из игры, ломает difficulty). Дёшево, важно.
2. **battle_sim: boss mechanics (aura/summon/breach).** Волны 5/10/15/20 без них — фейковый прогноз win-rate. Breach — одна ветка (умножение damage в атаке enemy по зданию), aura — тик по allies/buildings в радиусе, summon — таймер + spawn.
3. **econ_timing/pacing: применить `waveDemand.slotProductionMultiplier`** к слотам совпадающей шахты. Плюс 25% производства на «подсвеченной» шахте — это уже баланс-ручка, без неё стойла преувеличены.
4. **econ_timing/pacing: аттриция.** Ввести хотя бы модель «X% волн проигрываем → следующая волна начинается с частично разрушенным зданием + счётчик defeats увеличивает `damageFloor`». Иначе кумулятивная стоимость поражений не видна.
5. **econ_timing/pacing: ремонт-за-ресурсы.** Второй сток; без него добыча уходит только в стройку.
6. **`pacing_v2` merge_cap dynamic → зафиксировать = 5.** Сейчас модель ослабляет цену за счёт нереального роста `merge_cap` до 7. Убрать `elif e.merge_cap<7: e.merge_cap+=1`.
7. **econ_timing/pacing: early-start бонус.** Простая модель — «за каждый prep < window, бонус линейно уменьшается»; влияет на кумулятив gold заметно (у ранних волн бонус = 50% victoryGold).
8. **Reward draft.** Хотя бы «каждая волна даёт 1 карту типа X»: моделировать выбор permanent (goldMul/prodMul/baseHp) на волнах 1–5, потом каждые 3 волны — иначе gold/prod curve систематически занижена.
9. **pacing_v2: убрать «gold ONLY from battle»** — трейт Golden и capstone `passiveGold`/`goldenConversion` есть в конфиге; даже если игрок не выберет их сразу, sim должен принимать флаг «if traits ≠ 0 → добавить капель».
10. **battle_sim: building actives + shield** — самое дорогое (боль в реализации), но без них верхняя часть ladder в `difficulty.py` недооценивает поздние сборки. Можно отложить, но чётко пометить.
11. **battle_sim/difficulty: attrition на старте волны** — читать `damageFloor` и стартовать здания с `hp = maxHp × (1 − damageFloor)` (или с 0-hp = разрушенным вообще). Иначе сложность после первой потери недооценена.
12. **`upgradeCost` игнорируется как «мёртвый»** — на самом деле reward-draft карточка `oneShot.buildingUpgrade` даёт БЕСПЛАТНЫЙ апгрейд. Отразить в модели наград, не в building-стоимости.

### Не берём в симы (по договорённости)
- `demandResource` вручную по волне — sim просто читает поле, никакой автогенерации.
- Random placement зданий — sim ставит их вручную (LADDER в difficulty.py), это ок.
- Полная калибровка **после** пунктов 1–8 (11–12 — опционально).

### Незначительные, но полезные заплатки
- `battle_sim.py`: читать footprint/hp/damage/cd построек ИЗ `fortress-buildings.json`, а не BUILD dict (сейчас константы могут разъехаться при правке данных).
- `econ_timing.py`: `CUM_DEFENSE_COST` считать от `fortress-buildings.json.buyCost` × кривая мержа, а не рукой (это же уже сделано в `difficulty.py.cost_of`).
- Обе экономики: применять `productionMultipliers.battle` в фазе боя (T ≈ 30–60с/волна) — небольшой, но реальный вклад.
