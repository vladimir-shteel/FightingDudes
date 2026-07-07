# Fortress Redesign — Реализационные контракты (для агентов)

Одноразовый sheet архитектурных решений. Кодовая база: см. `plans/balance-and-systems-redesign.md`. Ветка: `codex/fortress-merge-from-master`.

## Единый принцип

- Все новые данные читаются через `CONFIG` в `js/game/config.js` (при необходимости добавь loader).
- Все действия игрока возвращают `{ok, reason}` как остальные `systems/*`.
- UI держим на существующих паттернах: `renderFortressField`, `renderFortressPopup`, `renderFortressShop`, `renderUpgradeChoices`, tick через `renderFrame`.
- Баланс — **тестовый**. Приоритет: работоспособные механики, не выверенные числа.

## 1) Enemy archetypes + telegraph

### Data
`data/fortress-units.json` — добавить архетипы под ключом «enemy» больше нет как одиночного объекта. Ввести:
```json
{
  "enemies": {
    "grunt":   {"name":"Grunt","icon":"👹","hp":28,"attack":10,"cooldownSeconds":0.8,"rangeTiles":0.42,"speedTilesPerSecond":0.95,"tag":"normal"},
    "runner":  {"name":"Runner","icon":"🐺","hp":18,"attack":6, "cooldownSeconds":0.7,"rangeTiles":0.42,"speedTilesPerSecond":1.55,"tag":"fast"},
    "armored": {"name":"Ogre","icon":"👺","hp":75,"attack":13,"cooldownSeconds":1.1,"rangeTiles":0.42,"speedTilesPerSecond":0.7, "tag":"armored"},
    "archerE": {"name":"Sniper","icon":"🏹","hp":22,"attack":9, "cooldownSeconds":1.4,"rangeTiles":2.4, "speedTilesPerSecond":0.9, "tag":"ranged"}
  }
}
```
Сохрани прежний `warrior/archer/rider/mage` под тем же корневым `fortressUnits` (allies).

Разделяем: config хранит `fortressUnits` (для союзников, старый ключ) + `fortressEnemies` (новый). Конфиг loader → `CONFIG.fortressEnemies`.

### Waves
`data/fortress-waves.json` — добавь опциональное `composition: [{archetype, count}, ...]`. Backward: если нет, используем `[{archetype:"grunt", count: enemyCount}]`.

Расписание архетипов (для куратора) вручную заложи в 24 волны: волна 2 вводит runner (штук 2), волна 4 armored (1), волна 6 archerE (2). Всегда есть grunt как база. Первая волна с новым архетипом ≤ той волны, где становится доступна его контра.

### Runtime
`fortressBattleSystem.js`:
- В `startFortressBattle` заведи `battle.spawnQueue = expandComposition(wave)` (массив ключей архетипов), удали `enemiesToSpawn` — используй `spawnQueue.length`.
- `tickSpawns`: берёт следующий ключ, зовёт `createFortressEnemy(state, archetype)`.
- `createFortressEnemy(state, archetypeKey)`: base = `CONFIG.fortressEnemies[archetypeKey]`; wave-скейл HP/attack по `waveNumber` (сохранить старые формулы).
- Поле `enemy.archetype` для UI и boss-логики.

### UI Telegraph
Новый компонент `renderWaveTelegraph()` — маленький ряд под "Wave x / N" показывает иконки архетипов для текущей и следующих 2 волн + маркер BOSS. Использует `wave.composition` и `wave.isBoss`.

## 2) Boss mechanics (после archetypes)

### Data
`data/fortress-units.json` (в `fortressEnemies`):
```json
"orcKing":  {"name":"Orc King","icon":"🐗","hp":420,"attack":18,"cooldownSeconds":1.1,"rangeTiles":0.5,"speedTilesPerSecond":0.65,"tag":"boss","mechanic":{"kind":"aura","radius":2.2,"damagePerSecond":6}},
"necromancer":{"name":"Necromancer","icon":"💀","hp":320,"attack":12,"cooldownSeconds":1.4,"rangeTiles":2.0,"speedTilesPerSecond":0.7,"tag":"boss","mechanic":{"kind":"summon","archetype":"grunt","intervalSeconds":6}},
"breacher": {"name":"Breacher","icon":"🐉","hp":560,"attack":26,"cooldownSeconds":1.3,"rangeTiles":0.45,"speedTilesPerSecond":0.55,"tag":"boss","mechanic":{"kind":"breach","damageMultVsBuildings":3}}
```
Waves 5/10/15/20 в `composition` включают один boss + свита.

### Runtime
- `enemy.mechanic` копируется из архетипа.
- `tickEnemies` добавляет ветку `tickBossMechanic(state, enemy, dt)`:
  - `aura`: каждую секунду ищет ally/buildings в радиусе → dps.
  - `summon`: таймер, спавнит доп `createFortressEnemy(state, archetype)` возле босса.
  - `breach`: множит урон по зданиям.
- UI: HP-bar босса всегда виден вверху арены.

## 3) Attrition + repair (buildings)

### State
`createFortressBuilding` → добавь `damageFloor: 0` (max HP уменьшение) и `hp = maxHp = definition.hp - damageFloor + bonus`.

### finishBattle rewrite (`fortressBattleSystem.js`)
- **Убрать** цикл `building.hp = building.maxHp` (свободный ремонт).
- `result === "defeat"`: для каждого building where `hp === 0` → `damageFloor += Math.round(building.maxHp * CONFIG.attrition.floorPerDefeat)` (например 0.2). Пересчитать `maxHp = base - damageFloor`, `hp = Math.max(1, Math.floor(maxHp * CONFIG.attrition.postDefeatHpFraction))` (например 0.4). Не-разрушенные: `hp` сохраняется как есть.
- `result === "victory"`: HP сохраняется как есть между волнами (никакого heal).

### Repair action
`fortressSystem.js`: 
```js
export function getFortressRepairCost(building) {
  const def = CONFIG.fortressBuildings[building.type];
  const missing = building.maxHp - building.hp;
  const per = CONFIG.attrition.repairCostPerHp?.[building.type] ?? {};
  return Object.fromEntries(Object.entries(per).map(([k, v]) => [k, Math.max(1, Math.ceil(missing * v))]));
}
export function repairFortressBuilding(state, buildingId) {...}
```
Или proximately: `repairCostPerHp` — доля от базового `buyCost` за HP.

Popup «Repair» кнопка под «Move». Только если `hp < maxHp` и не во время боя.

### balance.json
```json
"attrition": {
  "floorPerDefeat": 0.2,
  "postDefeatHpFraction": 0.4,
  "repairCostPerHpFractionOfBuyCost": 0.02
}
```

## 4) Merge-upgrade buildings

### Заменяет resource-based upgrade
Оставляем `upgradeCost` в data как безопасный fallback (пока не выпилили), но **UI кнопку «Upgrade» убираем**. Вместо неё — «Merge»/«Move» механика: при перемещении здания на клетку с таким же зданием того же уровня → merge.

### API
`fortressSystem.js`:
```js
export function mergeFortressBuildings(state, sourceId, targetId) { ... }
```
- Оба здания одного `type`, одного `level`, `level < definition.levels.length`.
- source удаляется (освобождает тайлы), target получает `level += 1`, `maxHp = nextLevel.hp + bonus`, `hp = maxHp` (свежий уровень — свежее здание), `damageFloor = 0`.
- Возвращает {ok, reason}.

### Wire into UX
`moveFortressBuilding` уже двигает. Добавить: если целевой origin уже занят зданием, и building.type === movingBuilding.type, и уровни равны, и уровень не max → вызвать `mergeFortressBuildings` вместо move.

В `renderFortressField` для tile с зданием при активном `movingBuildingId` подсвечивать как валидный target для merge (класс `.is-merge-target`).

Убрать кнопку `Upgrade` из popup (или поменять label на «Move / Merge»).

## 5) Worker capstone menu

### Data
`data/balance.json` под `workerTraits.capstones`:
```json
"capstones": {
  "yield":  [
    {"id":"yield-master","label":"Yield Master","description":"Slot production +100%.","effect":{"kind":"yieldMul","value":2.0}},
    {"id":"deep-vein","label":"Deep Vein","description":"Double demand bonus.","effect":{"kind":"demandMul","value":2.0}}
  ],
  "golden": [
    {"id":"midas","label":"Midas Touch","description":"Convert 25% of production to gold on top of existing.","effect":{"kind":"goldenConversion","value":0.25}},
    {"id":"trickle","label":"Golden Trickle","description":"+1 gold/sec passive.","effect":{"kind":"passiveGold","value":1}}
  ],
  "rush":   [
    {"id":"warmind","label":"Warmind","description":"Battle shift multiplier +2.0.","effect":{"kind":"rushBonus","value":2.0}},
    {"id":"skirmish","label":"Skirmisher","description":"Committed workers grant temporary damage +20% during battle.","effect":{"kind":"battleDamageBonus","value":0.2}}
  ],
  "hybrid": [
    {"id":"foreman","label":"Foreman (Y+G)","description":"+40% production, +8% goldenConversion.","effect":{"kind":"foreman"}},
    {"id":"warlord","label":"Warlord (R+Y)","description":"+50% production during battle shift.","effect":{"kind":"warlord"}}
  ]
}
```

### Runtime
- В `mergeWorkerTraitVectors` (или в `mergeReserveUnitIntoMineUnit` / `moveMineUnitToMineSlot`) при `level+1 === maxLevel` установить у нового рабочего `pendingCapstone: pickCandidateIds(traits)` — 2 капстоуна доминантной линии + 1 гибрид если вторая линия ≥ 60% от доминантной.
- `applyWorkerCapstone(state, unitId, capstoneId)` — валидирует, сохраняет `unit.capstone = capstoneId`, очищает `pendingCapstone`. Возврат {ok, reason}.
- `mineSystem.tickMineProduction`: применить эффект через хелперы `getWorkerCapstoneMultiplier(unit, "yield")`, `...`, `passiveGold` — прибавить в общий tick.
- Rush/battle-related капстоуны — учтены в `getWorkerRushMultiplier` и в battle damage (при committed).

### UI
- Модалка выбора капстоуна, аналог `renderUpgradeChoices` но per-worker; открывается автоматически, если есть worker с `pendingCapstone`. Одна модалка за раз.
- Иконка на самом рабочем показывает capstone label.

## 6) Top-building actives

### Data (в fortress-buildings.json)
Для каждого building **на последнем level entry** добавить:
```json
"active": {
  "id": "overcharge",
  "label": "Overcharge",
  "cooldownSeconds": 20,
  "cost": {"iron": 30},
  "effect": {"kind": "buildingDamageBoost", "durationSeconds": 6, "multiplier": 2.5}
}
```
Эффекты по типам:
- turret → `buildingDamageBoost`
- barracks → `spawnSquad` (+3 warriors instant)
- wall / bigWall → `shieldNearby` (radius, dmg reduction)
- archery → `volley` (мгновенный залп по 3 врагам)
- stables → `charge` (спавн 2 rider)
- mageTower → `frost` (замедление всех врагов N сек)
- mine (trap) → пропускаем (одноразовые ловушки).

### Runtime
`fortressSystem.js`:
```js
export function triggerBuildingActive(state, buildingId) { ... }
```
- Только если battle active.
- Проверяет `building.level === definition.levels.length`, `activeCooldown <= 0`, ресурсы.
- Списывает ресурсы, ставит `activeCooldown = definition.levels[.].active.cooldownSeconds`, применяет эффект (spawnSquad→ push allies; buildingDamageBoost → set `building.activeBoost = {until: now + duration, mult}` и tickBuildingActions используем `mult` если активен; аналогично для shield).
- Кулдаун тикать в `tickFortressBattle`.

### UI
- В `renderFortressField` на building tile отображать кнопку активки (только на макс-уровне и во время боя), с индикатором кулдауна.

## 7) Balance-sim sync (последним)

Скрипты `tools/balance-sim/*.py`. В шапке каждого скрипта продублированы константы. После всех кодовых правок обновить:
- `pacing_v2.py`: экспонента + база + новые waves + trait multipliers.
- `difficulty.py` / `battle_sim.py`: enemy archetypes → минимально смоделировать средний DPS/HP.
- `econ_timing.py`: capstone golden трейт, attrition.

Читать `data/*.json` напрямую скриптами (сейчас параметры дублируются) — рефактор в отдельной задаче.

---

**Order of implementation** (принято):
1. Enemy archetypes + telegraph (unlocks bosses, wave data shape).
2. Boss mechanics.
3. Attrition + repair.
4. Merge-upgrade buildings.
5. Worker capstones.
6. Top-building actives.
7. Sim sync.
