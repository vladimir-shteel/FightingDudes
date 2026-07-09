# GDD: Замена боевой системы FightingDudes

**Версия:** 1.0  
**Дата:** 2026-07-08  
**Репозиторий:** `FightingDudes/master`

---

## 1. Цель документа

Заменить текущую боевую систему «стенка на стенку» (все юниты бегут к ближайшему врагу, бои однообразны) на систему с **контрпиками** (треугольник юнитов), **позиционированием** (передний/задний ряд), **летающими юнитами** и **камикадзе**. Шахты, мердж и экономика остаются без изменений.

---

## 2. Что НЕ меняется

| Система | Файлы | Статус |
|---|---|---|
| Шахты и добыча ресурсов | `js/game/systems/mineSystem.js` | Без изменений |
| Мердж юнитов | `js/game/systems/reserveSystem.js` → `mergeReservePair` | Без изменений |
| Покупка юнитов | `js/game/systems/reserveSystem.js` → `buyReserveUnit` | Без изменений |
| Генерация ID | `js/game/utils.js` → `generateId` | Без изменений |
| Тик-рейт и основной цикл | `CONFIG.tickRateMs` (100мс), `js/game/state.js` | Без изменений |
| Физический движок | `planck@1.5.0` (CDN) | Используется, модифицируется |

---

## 3. Что меняется

### 3.1 Сводка изменений

| Что | Было | Стало |
|---|---|---|
| Классы юнитов | Нет (все «Dude») | 10 классов, разблокировка по ярусам мерджа |
| Выбор класса | Нет | При переводе из резерва в казарму — модалка выбора |
| Боевой таргетинг | `chooseClosestTarget` → ближайший | Без изменений (ближайший), но позиция и движение юнитов делают разницу |
| Формация | Все в одну линию | Передний / задний ряд (выбор для каждого юнита) |
| Типы движения | Все одинаковые (наземные) | Наземный, летающий, камикадзе |
| Проигрыш | Неясное поведение | Волна сбрасывается на 100% HP, золото за убитых остаётся |
| Волны | `data/waves.json` — простые составы | Тактические паззлы с контрпиками |

---

## 4. Система классов

### 4.1 Ярусы специализации

Класс юнита определяется при переводе из резерва (шахты) в казарму. Доступные классы зависят от **уровня мерджа** работника:

| Ярус | Уровень мерджа | Доступные классы |
|---|---|---|
| Базовый | 1–2 | Мечник, Лучник |
| 1-й | 3–4 | + Рыцарь, Громила |
| 2-й | 5–6 | + Щитоносец, Копейщик |
| 3-й | 7–8 | + Отравитель, Паладин |
| 4-й | 9–12 | + Берсерк, Маг |

Работник **любого** уровня может стать любым классом из доступных на его ярусе **и ниже**. Работник ур.8 может стать и Мечником (ярус Базовый, со статами ур.8), и Паладином (ярус 3).

### 4.2 Спецификация классов

#### Наземные (ближний бой)

| Класс | Мин.ур. | Тип атаки | Базовые статы (ур.3) | Механика |
|---|---|---|---|---|
| **Мечник** | 1 | Ближний, одиночный | HP 58, Атака 10 | Простой боец. Дешёвый. Сила в количестве |
| **Рыцарь** | 3 | Ближний, одиночный | HP 110, Атака 16 | Соло-танк. Огромное HP, высокая атака, бьёт одного |
| **Громила** | 3 | Ближний, **AoE** | HP 75, Атака 10 | Удар наносит урон **всем** врагам в радиусе `splashRadius: 1.8` от точки удара |
| **Щитоносец** | 5 | Ближний, одиночный | HP 150, Атака 3 | Почти не бьёт, но крайне крепкий. Задерживает врагов |
| **Копейщик** | 5 | Ближний, одиночный | HP 55, Атака 22 | Хрупкий, но огромный урон. Пробивает танков |
| **Берсерк** | 9 | Ближний, одиночный | HP 160, Атака 8 → ×3 | Множитель атаки растёт при потере HP: `attackMultiplier = 1 + 2 × (1 - currentHP / maxHP)` |

#### Наземные (дальний бой)

| Класс | Мин.ур. | Тип атаки | Базовые статы (ур.3) | Механика |
|---|---|---|---|---|
| **Лучник** | 1 | Дальний, одиночный | HP 40, Атака 8 | `attackRange: 12`. Останавливается на расстоянии, стреляет. Единственный способ бить **летающих** на базовом ярусе |
| **Отравитель** | 7 | Ближний + DoT | HP 100, Атака 4 | При попадании вешает `poison: {dps: 4, duration: 5}` на цель. Яд **игнорирует** броню |
| **Паладин** | 7 | Ближний, одиночный | HP 180, Атака 6 | Каждые 3 с лечит ближайшего раненого союзника в радиусе 6 на `healAmount: 15` HP |
| **Маг** | 9 | Дальний, **AoE** | HP 100, Атака 14 | `attackRange: 14`, удар по площади `splashRadius: 2.0`. Бьёт **летающих**. Хрупкий |

#### Специальное движение

| Класс | Движение | Механика |
|---|---|---|
| **Камикадзе** | Наземный, **игнорирует** врагов | Бежит мимо переднего ряда к заднему. `targetMode: "backline"`. Не останавливается для боя. При контакте с целью — один удар `explosionDamage` по площади `explosionRadius: 2.5`, затем **умирает** |
| **Летающий** | Летающий | Игнорирует наземных бойцов (нет физической коллизии с наземными). Летит к заднему ряду. Может быть атакован **только** юнитами с `canHitFlying: true` (Лучник, Маг). Мечники, Рыцари, Громила — не могут его ударить |

### 4.3 Масштабирование статов по уровню мерджа

Формула: `stat(level) = baseStat × (1 + 0.25 × (level - minLevel))`

Пример для Мечника (baseStat при ур.1: HP 32, Атака 7):

| Уровень | HP | Атака |
|---|---|---|
| 1 | 32 | 7 |
| 2 | 40 | 9 |
| 3 | 48 | 11 |
| 4 | 56 | 12 |
| 5 | 64 | 14 |
| 6 | 72 | 16 |

Пример для Рыцаря (baseStat при ур.3: HP 110, Атака 16):

| Уровень | HP | Атака |
|---|---|---|
| 3 | 110 | 16 |
| 4 | 138 | 20 |
| 5 | 165 | 24 |
| 6 | 193 | 28 |

> [!NOTE]
> Статы растут **медленнее**, чем стоимость мерджа. 8 Мечников ур.1 (суммарно 256 HP) сильнее по числам, чем 1 Рыцарь ур.3 (110 HP). Но Рыцарь не умирает от AoE. Выбор «много слабых / мало сильных» зависит от волны.

---

## 5. Формация (передний / задний ряд)

### 5.1 Механика

Каждый юнит на плацдарме (bridgehead) имеет свойство `formationRow: "front" | "back"`. Игрок назначает ряд **индивидуально** для каждого из 8 слотов. Ограничений по количеству юнитов в каждом ряду нет.

### 5.2 Влияние на спавн

При создании `battleUnit` в начале боя:

```
Если formationRow === "front":
  spawnX = CONFIG.battle.allySpawnX          // стандартная позиция
Если formationRow === "back":
  spawnX = CONFIG.battle.allySpawnX - 15     // на 15 единиц левее (дальше от врага)
```

Для врагов — зеркально:
```
Если formationRow === "front":
  spawnX = CONFIG.battle.enemySpawnX
Если formationRow === "back":
  spawnX = CONFIG.battle.enemySpawnX + 15
```

### 5.3 Результат

Юниты заднего ряда вступают в бой на **~2 секунды позже** переднего. Таргетинг остаётся `chooseClosestTarget` — но поскольку передний ряд ближе к врагам, враги автоматически бьют передний ряд первым.

### 5.4 UI

На экране плацдарма (`garrisonScreen.js`) у каждого слота — переключатель `[ Передний | Задний ]`. По умолчанию все юниты в переднем ряду.

---

## 6. Типы движения

### 6.1 Наземный (стандартный)

Текущее поведение: юнит идёт к цели, при достижении `attackRange` — останавливается и атакует. Физическое тело сталкивается с другими наземными телами через `Planck.js`.

Без изменений.

### 6.2 Летающий

**Физика:**
- При создании физического тела в `battlePhysics.js`: `filterMaskBits` НЕ включает наземные категории. Летающий **не сталкивается** с наземными юнитами.
- Отдельные категории: `CATEGORY_FLYING_ALLY = 0x0010`, `CATEGORY_FLYING_ENEMY = 0x0020`.
- Летающие сталкиваются только с другими летающими и стенами арены.

**Таргетинг:**
- Летающий юнит выбирает цель среди **всех** врагов (наземных и летающих) по `chooseClosestTarget`.
- Наземный юнит без `canHitFlying: true` **пропускает** летающих в списке целей (фильтр перед `chooseClosestTarget`).
- Юниты с `canHitFlying: true` (Лучник, Маг) выбирают из **всех** врагов.

**Движение:**
- Тот же steering, но без столкновений с наземными → летающий **пролетает** через передний ряд.
- Y-координата отрисовки: `renderY = y - flyHeight` (визуально выше, тень на земле).

### 6.3 Камикадзе

**Движение:**
- `targetMode: "backline"` — цель выбирается **не** как ближайший враг, а как **ближайший враг с `formationRow === "back"`**. Если юнитов с `"back"` нет — целится в ближайшего.
- `ignoreCollision: true` — физическое тело **не сталкивается** с вражескими наземными юнитами (проезжает мимо).
- `moveSpeed` повышен (×1.5 от стандартного).

**Атака:**
- При достижении цели: наносит `explosionDamage` **всем** врагам в `explosionRadius`. Затем `currentHP = 0` (самоуничтожение).
- Имеет обычный HP — может быть убит по дороге (лучниками).

---

## 7. Экономика поражения

### 7.1 Текущее поведение (проблема)

Сейчас здоровье врагов **не сбрасывается** между попытками. Игрок может посылать юнитов по одному и «стачивать» волну за 10 попыток. Это убивает необходимость думать над составом.

### 7.2 Новое поведение

**При поражении (все союзные юниты погибли):**

1. **Волна сбрасывается.** Все враги текущей волны восстанавливают HP до 100%. Состав волны не меняется.
2. **Юниты игрока потеряны.** Все юниты, отправленные в бой, удаляются из состояния (`state.garrison`, `state.bridgehead`).
3. **Утешительная награда.** За каждого **убитого в этой попытке** врага игрок получает `goldReward` (поле из `waves.json`). Золото начисляется сразу при убийстве врага (уже реализовано).

**При победе (все враги убиты):**

1. Волна считается пройденной. `state.battle.currentWave` увеличивается.
2. Выжившие юниты возвращаются в гарнизон.
3. Награда за волну начисляется.

### 7.3 Реализация

В `battleSystem.js`, функция проверки окончания боя:

```javascript
// При поражении:
if (aliveAllies.length === 0 && aliveEnemies.length > 0) {
  // НЕ сдвигать waveProgress.defeatedEnemyIndexesByWave
  // Волна остаётся текущей, враги на следующий заход будут созданы заново с полным HP
  state.battle.phase = "lost";
}
```

---

## 8. Спецификация волн: Локация 1 — Каменный век

### 8.1 Доступные классы игрока

Мечник (ур.1+), Лучник (ур.1+), Рыцарь (ур.3+), Громила (ур.3+)

### 8.2 Волны

#### Волна 1-1: «Первая стычка»

```json
{
  "name": "Первая стычка",
  "enemies": [
    { "front": [
      { "class": "swordsman", "name": "Дикарь", "icon": "🪓", "health": 22, "attack": 4, "attackSpeed": 1.0, "goldReward": 2 },
      { "class": "swordsman", "name": "Дикарь", "icon": "🪓", "health": 22, "attack": 4, "attackSpeed": 1.0, "goldReward": 2 },
      { "class": "swordsman", "name": "Дикарь", "icon": "🪓", "health": 22, "attack": 4, "attackSpeed": 1.0, "goldReward": 2 }
    ]}
  ]
}
```

**Задача:** Знакомство. Любые 2–3 Мечника побеждают.

---

#### Волна 1-2: «Большой зверь»

```json
{
  "name": "Большой зверь",
  "enemies": [
    { "front": [
      { "class": "knight", "name": "Медведь", "icon": "🐻", "health": 90, "attack": 12, "attackSpeed": 0.8, "goldReward": 8 }
    ]}
  ]
}
```

**Задача:** Один сильный враг. 1–2 Мечника проиграют. Нужно 3–4.  
**Урок:** Толпа бьёт одиночку.

---

#### Волна 1-3: «Стая»

```json
{
  "name": "Стая",
  "enemies": [
    { "front": [
      { "class": "swordsman", "name": "Крыса", "icon": "🐀", "health": 12, "attack": 3, "attackSpeed": 1.3, "moveSpeed": 16, "goldReward": 1 },
      { "class": "swordsman", "name": "Крыса", "icon": "🐀", "health": 12, "attack": 3, "attackSpeed": 1.3, "moveSpeed": 16, "goldReward": 1 },
      { "class": "swordsman", "name": "Крыса", "icon": "🐀", "health": 12, "attack": 3, "attackSpeed": 1.3, "moveSpeed": 16, "goldReward": 1 },
      { "class": "swordsman", "name": "Крыса", "icon": "🐀", "health": 12, "attack": 3, "attackSpeed": 1.3, "moveSpeed": 16, "goldReward": 1 },
      { "class": "swordsman", "name": "Крыса", "icon": "🐀", "health": 12, "attack": 3, "attackSpeed": 1.3, "moveSpeed": 16, "goldReward": 1 },
      { "class": "swordsman", "name": "Крыса", "icon": "🐀", "health": 12, "attack": 3, "attackSpeed": 1.3, "moveSpeed": 16, "goldReward": 1 }
    ]}
  ]
}
```

**Задача:** 6 мелких врагов. Мечники справятся, но если игрок смерджил Громилу — тот перебьёт всех AoE за 2 удара.  
**Урок:** Сплэш бьёт толпу.

---

#### Волна 1-4: «Первый полёт» 🦅

```json
{
  "name": "Первый полёт",
  "enemies": [
    { "front": [
      { "class": "swordsman", "name": "Дикарь", "icon": "🪓", "health": 22, "attack": 4, "attackSpeed": 1.0, "goldReward": 2 },
      { "class": "swordsman", "name": "Дикарь", "icon": "🪓", "health": 22, "attack": 4, "attackSpeed": 1.0, "goldReward": 2 }
    ]},
    { "flying": [
      { "class": "flying", "name": "Орёл", "icon": "🦅", "health": 20, "attack": 5, "attackSpeed": 1.0, "moveSpeed": 14, "movementType": "flying", "goldReward": 5 }
    ]}
  ]
}
```

**Задача:** Орёл пролетает мимо мечников. Без Лучника — проигрыш.  
**Урок:** Лучник обязателен против летающих.

---

#### Волна 1-5: «Контрпик»

```json
{
  "name": "Контрпик",
  "enemies": [
    { "front": [
      { "class": "brute", "name": "Камнемёт", "icon": "🪨", "health": 80, "attack": 10, "attackSpeed": 0.7, "splashRadius": 1.8, "goldReward": 10 }
    ]}
  ]
}
```

**Задача:** Если послать толпу Мечников — Камнемёт убьёт всех AoE. Нужен 1 Рыцарь (одиночный танк).  
**Урок:** Треугольник замкнулся: толпа < сплэш < танк < толпа.

---

#### Волна 1-6: «Первый паззл»

```json
{
  "name": "Первый паззл",
  "enemies": [
    { "front": [
      { "class": "swordsman", "name": "Крыса", "icon": "🐀", "health": 12, "attack": 3, "attackSpeed": 1.3, "moveSpeed": 16, "goldReward": 1 },
      { "class": "swordsman", "name": "Крыса", "icon": "🐀", "health": 12, "attack": 3, "attackSpeed": 1.3, "moveSpeed": 16, "goldReward": 1 },
      { "class": "swordsman", "name": "Крыса", "icon": "🐀", "health": 12, "attack": 3, "attackSpeed": 1.3, "moveSpeed": 16, "goldReward": 1 },
      { "class": "swordsman", "name": "Крыса", "icon": "🐀", "health": 12, "attack": 3, "attackSpeed": 1.3, "moveSpeed": 16, "goldReward": 1 }
    ]},
    { "back": [
      { "class": "knight", "name": "Медведь", "icon": "🐻", "health": 90, "attack": 12, "attackSpeed": 0.8, "goldReward": 8 }
    ]}
  ]
}
```

**Задача:** Крысы впереди, Медведь сзади. Нужен Громила вперёд (зачистить крыс AoE), Рыцарь назад (подойдёт и встретит Медведя).  
**Урок:** Расстановка по рядам меняет исход.

---

#### Волна 1-7: «Вождь племени» (Босс)

```json
{
  "name": "Вождь племени",
  "enemies": [
    { "front": [
      { "class": "swordsman", "name": "Дикарь", "icon": "🪓", "health": 22, "attack": 4, "attackSpeed": 1.0, "goldReward": 2 },
      { "class": "swordsman", "name": "Дикарь", "icon": "🪓", "health": 22, "attack": 4, "attackSpeed": 1.0, "goldReward": 2 },
      { "class": "swordsman", "name": "Дикарь", "icon": "🪓", "health": 22, "attack": 4, "attackSpeed": 1.0, "goldReward": 2 },
      { "class": "brute", "name": "Камнемёт", "icon": "🪨", "health": 80, "attack": 10, "attackSpeed": 0.7, "splashRadius": 1.8, "goldReward": 10 }
    ]},
    { "back": [
      { "class": "knight", "name": "Вождь", "icon": "👹", "health": 150, "attack": 18, "attackSpeed": 0.9, "goldReward": 20, "isBoss": true }
    ]},
    { "flying": [
      { "class": "flying", "name": "Орёл", "icon": "🦅", "health": 20, "attack": 5, "attackSpeed": 1.0, "moveSpeed": 14, "movementType": "flying", "goldReward": 5 }
    ]}
  ]
}
```

**Задача:** Финальный экзамен. Дикари (толпа) + Камнемёт (сплэш) + Вождь (танк) + Орёл (летающий). Нужен смешанный отряд + правильная расстановка.

---

## 9. Спецификация волн: Локация 2 — Бронзовый век

### 9.1 Разблокировка

После прохождения Локации 1 максимальный мердж повышается до **6**. Открываются: **Щитоносец** (ур.5+), **Копейщик** (ур.5+).

### 9.2 Новые типы врагов

| Тип | Ключевые поля | Поведение |
|---|---|---|
| Вражеский Лучник | `attackRange: 12`, `canHitFlying: true` | Стреляет из заднего ряда |
| Вражеский Щитоносец | `health: 65`, `attack: 2` | Крепкий, задерживает |
| Колесница-таран (камикадзе) | `movementType: "kamikaze"`, `targetMode: "backline"`, `explosionDamage: 30`, `explosionRadius: 2.5`, `health: 35` | Бежит мимо переднего ряда, взрывается в тылу |
| Стая ворон (летающая стая) | `movementType: "flying"`, 4 шт. по `health: 10`, `attack: 3` | Летят к заднему ряду |

### 9.3 Волны

#### Волна 2-1: «Стена»

```json
{
  "name": "Стена",
  "enemies": [
    { "front": [
      { "class": "shieldbearer", "name": "Щитоносец", "icon": "🛡️", "health": 65, "attack": 2, "attackSpeed": 0.8, "goldReward": 5 },
      { "class": "shieldbearer", "name": "Щитоносец", "icon": "🛡️", "health": 65, "attack": 2, "attackSpeed": 0.8, "goldReward": 5 }
    ]}
  ]
}
```

**Задача:** Мечники победят, но долго (HP 65, атака 2). Копейщик (атака 22) пробивает за секунды.  
**Урок:** Копейщик — ответ на крепких.

---

#### Волна 2-2: «Стрелки за стеной»

```json
{
  "name": "Стрелки за стеной",
  "enemies": [
    { "front": [
      { "class": "shieldbearer", "name": "Щитоносец", "icon": "🛡️", "health": 65, "attack": 2, "attackSpeed": 0.8, "goldReward": 5 }
    ]},
    { "back": [
      { "class": "archer", "name": "Лучник", "icon": "🏹", "health": 28, "attack": 8, "attackSpeed": 0.8, "attackRange": 12, "goldReward": 6 },
      { "class": "archer", "name": "Лучник", "icon": "🏹", "health": 28, "attack": 8, "attackSpeed": 0.8, "attackRange": 12, "goldReward": 6 }
    ]}
  ]
}
```

**Задача:** Мечники застрянут на Щитоносце, Лучники расстреляют. Нужен свой Щитоносец впереди (переживёт обстрел) + Копейщик сзади (быстро пробьёт стену).

---

#### Волна 2-3: «Таран» 🐗💥

```json
{
  "name": "Таран",
  "enemies": [
    { "front": [
      { "class": "swordsman", "name": "Воин", "icon": "⚔️", "health": 28, "attack": 5, "attackSpeed": 1.0, "goldReward": 3 },
      { "class": "swordsman", "name": "Воин", "icon": "⚔️", "health": 28, "attack": 5, "attackSpeed": 1.0, "goldReward": 3 },
      { "class": "swordsman", "name": "Воин", "icon": "⚔️", "health": 28, "attack": 5, "attackSpeed": 1.0, "goldReward": 3 }
    ]},
    { "kamikaze": [
      { "class": "kamikaze", "name": "Колесница", "icon": "🐗", "health": 35, "moveSpeed": 22, "explosionDamage": 30, "explosionRadius": 2.5, "movementType": "kamikaze", "targetMode": "backline", "goldReward": 8 }
    ]}
  ]
}
```

**Задача:** Колесница бежит мимо переднего ряда к лучникам. 2–3 Лучника расстреляют её за 4 секунды пробежки. Или Щитоносец в заднем ряду перехватит взрыв.  
**Урок:** Задний ряд — не безопасная зона.

---

#### Волна 2-4: «Воздушная стая»

```json
{
  "name": "Воздушная стая",
  "enemies": [
    { "front": [
      { "class": "shieldbearer", "name": "Щитоносец", "icon": "🛡️", "health": 65, "attack": 2, "attackSpeed": 0.8, "goldReward": 5 },
      { "class": "swordsman", "name": "Воин", "icon": "⚔️", "health": 28, "attack": 5, "attackSpeed": 1.0, "goldReward": 3 },
      { "class": "swordsman", "name": "Воин", "icon": "⚔️", "health": 28, "attack": 5, "attackSpeed": 1.0, "goldReward": 3 }
    ]},
    { "flying": [
      { "class": "flying", "name": "Ворона", "icon": "🐦‍⬛", "health": 10, "attack": 3, "attackSpeed": 1.2, "moveSpeed": 14, "movementType": "flying", "goldReward": 2 },
      { "class": "flying", "name": "Ворона", "icon": "🐦‍⬛", "health": 10, "attack": 3, "attackSpeed": 1.2, "moveSpeed": 14, "movementType": "flying", "goldReward": 2 },
      { "class": "flying", "name": "Ворона", "icon": "🐦‍⬛", "health": 10, "attack": 3, "attackSpeed": 1.2, "moveSpeed": 14, "movementType": "flying", "goldReward": 2 },
      { "class": "flying", "name": "Ворона", "icon": "🐦‍⬛", "health": 10, "attack": 3, "attackSpeed": 1.2, "moveSpeed": 14, "movementType": "flying", "goldReward": 2 }
    ]}
  ]
}
```

**Задача:** Два фронта одновременно — наземный и воздушный. 3 Лучника в тылу сбивают стаю за ~3 сек.

---

#### Волна 2-5: «Двойной удар»

```json
{
  "name": "Двойной удар",
  "enemies": [
    { "front": [
      { "class": "swordsman", "name": "Воин", "icon": "⚔️", "health": 28, "attack": 5, "attackSpeed": 1.0, "goldReward": 3 },
      { "class": "swordsman", "name": "Воин", "icon": "⚔️", "health": 28, "attack": 5, "attackSpeed": 1.0, "goldReward": 3 },
      { "class": "swordsman", "name": "Воин", "icon": "⚔️", "health": 28, "attack": 5, "attackSpeed": 1.0, "goldReward": 3 },
      { "class": "swordsman", "name": "Воин", "icon": "⚔️", "health": 28, "attack": 5, "attackSpeed": 1.0, "goldReward": 3 }
    ]},
    { "kamikaze": [
      { "class": "kamikaze", "name": "Колесница", "icon": "🐗", "health": 35, "moveSpeed": 22, "explosionDamage": 30, "explosionRadius": 2.5, "movementType": "kamikaze", "targetMode": "backline", "goldReward": 8 }
    ]},
    { "flying": [
      { "class": "flying", "name": "Орёл", "icon": "🦅", "health": 20, "attack": 5, "attackSpeed": 1.0, "moveSpeed": 14, "movementType": "flying", "goldReward": 5 }
    ]}
  ]
}
```

**Задача:** Колесница + Орёл атакуют тыл одновременно. Нужно много Лучников ИЛИ Щитоносец в заднем ряду.

---

#### Волна 2-6: «Крепость»

```json
{
  "name": "Крепость",
  "enemies": [
    { "front": [
      { "class": "shieldbearer", "name": "Щитоносец", "icon": "🛡️", "health": 65, "attack": 2, "attackSpeed": 0.8, "goldReward": 5 },
      { "class": "shieldbearer", "name": "Щитоносец", "icon": "🛡️", "health": 65, "attack": 2, "attackSpeed": 0.8, "goldReward": 5 },
      { "class": "brute", "name": "Камнемёт", "icon": "🪨", "health": 80, "attack": 10, "attackSpeed": 0.7, "splashRadius": 1.8, "goldReward": 10 }
    ]},
    { "back": [
      { "class": "archer", "name": "Лучник", "icon": "🏹", "health": 28, "attack": 8, "attackSpeed": 0.8, "attackRange": 12, "goldReward": 6 },
      { "class": "archer", "name": "Лучник", "icon": "🏹", "health": 28, "attack": 8, "attackSpeed": 0.8, "attackRange": 12, "goldReward": 6 }
    ]},
    { "flying": [
      { "class": "flying", "name": "Орёл", "icon": "🦅", "health": 20, "attack": 5, "attackSpeed": 1.0, "moveSpeed": 14, "movementType": "flying", "goldReward": 5 }
    ]}
  ]
}
```

**Задача:** Стена + сплэш + стрелки + летающий. Рыцарь впереди танкует Камнемёта, Копейщик пробивает стену, Лучники сбивают Орла.

---

#### Волна 2-7: «Царь зверей» (Босс)

```json
{
  "name": "Царь зверей",
  "enemies": [
    { "front": [
      { "class": "swordsman", "name": "Воин", "icon": "⚔️", "health": 28, "attack": 5, "attackSpeed": 1.0, "goldReward": 3 },
      { "class": "swordsman", "name": "Воин", "icon": "⚔️", "health": 28, "attack": 5, "attackSpeed": 1.0, "goldReward": 3 },
      { "class": "swordsman", "name": "Воин", "icon": "⚔️", "health": 28, "attack": 5, "attackSpeed": 1.0, "goldReward": 3 },
      { "class": "shieldbearer", "name": "Щитоносец", "icon": "🛡️", "health": 65, "attack": 2, "attackSpeed": 0.8, "goldReward": 5 },
      { "class": "brute", "name": "Камнемёт", "icon": "🪨", "health": 80, "attack": 10, "attackSpeed": 0.7, "splashRadius": 1.8, "goldReward": 10 }
    ]},
    { "back": [
      { "class": "knight", "name": "Царь", "icon": "👑", "health": 200, "attack": 20, "attackSpeed": 0.9, "goldReward": 30, "isBoss": true }
    ]},
    { "kamikaze": [
      { "class": "kamikaze", "name": "Колесница", "icon": "🐗", "health": 35, "moveSpeed": 22, "explosionDamage": 30, "explosionRadius": 2.5, "movementType": "kamikaze", "targetMode": "backline", "goldReward": 8 },
      { "class": "kamikaze", "name": "Колесница", "icon": "🐗", "health": 35, "moveSpeed": 22, "explosionDamage": 30, "explosionRadius": 2.5, "movementType": "kamikaze", "targetMode": "backline", "goldReward": 8 }
    ]},
    { "flying": [
      { "class": "flying", "name": "Ворона", "icon": "🐦‍⬛", "health": 10, "attack": 3, "attackSpeed": 1.2, "moveSpeed": 14, "movementType": "flying", "goldReward": 2 },
      { "class": "flying", "name": "Ворона", "icon": "🐦‍⬛", "health": 10, "attack": 3, "attackSpeed": 1.2, "moveSpeed": 14, "movementType": "flying", "goldReward": 2 },
      { "class": "flying", "name": "Ворона", "icon": "🐦‍⬛", "health": 10, "attack": 3, "attackSpeed": 1.2, "moveSpeed": 14, "movementType": "flying", "goldReward": 2 },
      { "class": "flying", "name": "Ворона", "icon": "🐦‍⬛", "health": 10, "attack": 3, "attackSpeed": 1.2, "moveSpeed": 14, "movementType": "flying", "goldReward": 2 }
    ]}
  ]
}
```

**Задача:** Финальный экзамен Локации 2. Все типы угроз: толпа + сплэш + стенка + босс + 2 камикадзе + стая. Нужен полный набор инструментов и правильная расстановка.

---

## 10. Технические изменения по файлам

### 10.1 `data/unit-levels.json`

**Было:** Плоский массив `levels` с полями `level, name, icon, baseHealth, baseAttack, baseAttackSpeed`.

**Стало:** Расширить структуру. Добавить маппинг классов:

```json
{
  "levels": [
    { "level": 1, "baseHealth": 32, "baseAttack": 7, "baseAttackSpeed": 1.0 },
    { "level": 2, "baseHealth": 40, "baseAttack": 9, "baseAttackSpeed": 1.0 }
  ],
  "classes": {
    "swordsman":   { "name": "Мечник",     "icon": "🪓", "minLevel": 1, "healthMult": 1.0, "attackMult": 1.0, "attackType": "melee", "canHitFlying": false },
    "archer":      { "name": "Лучник",     "icon": "🏹", "minLevel": 1, "healthMult": 0.7, "attackMult": 0.85, "attackType": "ranged", "attackRange": 12, "canHitFlying": true },
    "knight":      { "name": "Рыцарь",     "icon": "🛡️", "minLevel": 3, "healthMult": 2.3, "attackMult": 1.6, "attackType": "melee", "canHitFlying": false },
    "brute":       { "name": "Громила",    "icon": "💥", "minLevel": 3, "healthMult": 1.5, "attackMult": 1.0, "attackType": "melee_aoe", "splashRadius": 1.8, "canHitFlying": false },
    "shieldbearer":{ "name": "Щитоносец",  "icon": "🛡️", "minLevel": 5, "healthMult": 3.0, "attackMult": 0.3, "attackType": "melee", "canHitFlying": false },
    "spearman":    { "name": "Копейщик",   "icon": "🗡️", "minLevel": 5, "healthMult": 0.9, "attackMult": 2.2, "attackType": "melee", "canHitFlying": false },
    "poisoner":    { "name": "Отравитель", "icon": "☠️", "minLevel": 7, "healthMult": 1.6, "attackMult": 0.4, "attackType": "melee", "canHitFlying": false, "poisonDps": 4, "poisonDuration": 5 },
    "paladin":     { "name": "Паладин",    "icon": "✝️", "minLevel": 7, "healthMult": 3.6, "attackMult": 0.6, "attackType": "melee", "canHitFlying": false, "healAmount": 15, "healInterval": 3, "healRadius": 6 },
    "berserker":   { "name": "Берсерк",    "icon": "🔥", "minLevel": 9, "healthMult": 2.5, "attackMult": 0.8, "attackType": "melee", "canHitFlying": false, "berserkerScaling": true },
    "mage":        { "name": "Маг",        "icon": "🔮", "minLevel": 9, "healthMult": 1.6, "attackMult": 1.4, "attackType": "ranged_aoe", "attackRange": 14, "splashRadius": 2.0, "canHitFlying": true }
  }
}
```

**Формула статов юнита:**
```
finalHealth = levels[level].baseHealth × classes[class].healthMult
finalAttack = levels[level].baseAttack × classes[class].attackMult
```

### 10.2 `data/waves.json`

**Было:** Плоский массив массивов врагов.

**Стало:** Массив объектов-волн. Каждая волна содержит группы врагов по рядам:

```json
[
  {
    "name": "Первая стычка",
    "location": 1,
    "groups": [
      {
        "formationRow": "front",
        "enemies": [
          { "class": "swordsman", "name": "Дикарь", "icon": "🪓", "health": 22, "attack": 4, "attackSpeed": 1.0, "goldReward": 2 }
        ]
      },
      {
        "formationRow": "flying",
        "enemies": []
      }
    ]
  }
]
```

### 10.3 `js/game/factories.js`

**Добавить:** `createBattleUnit(reserveUnit, classId, formationRow)` — создаёт боевого юнита из резервного с указанным классом и рядом.

```javascript
export function createBattleUnit(reserveUnit, classId, formationRow = "front") {
  const classData = getClassConfig(classId);
  const levelData = getUnitLevelData(reserveUnit.level);

  return {
    id: generateId("battle"),
    sourceUnitId: reserveUnit.id,
    name: classData.name,
    class: classId,
    level: reserveUnit.level,
    icon: classData.icon,
    formationRow,

    maxHealth: Math.round(levelData.baseHealth * classData.healthMult),
    currentHealth: Math.round(levelData.baseHealth * classData.healthMult),
    attack: Math.round(levelData.baseAttack * classData.attackMult),
    attackSpeed: levelData.baseAttackSpeed,
    attackType: classData.attackType,
    attackRange: classData.attackRange ?? 0,
    splashRadius: classData.splashRadius ?? 0,
    canHitFlying: classData.canHitFlying ?? false,

    movementType: classData.movementType ?? "ground",
    // для камикадзе:
    targetMode: classData.targetMode ?? "closest",
    explosionDamage: classData.explosionDamage ?? 0,
    explosionRadius: classData.explosionRadius ?? 0,
    // для отравителя:
    poisonDps: classData.poisonDps ?? 0,
    poisonDuration: classData.poisonDuration ?? 0,
    // для паладина:
    healAmount: classData.healAmount ?? 0,
    healInterval: classData.healInterval ?? 0,
    healRadius: classData.healRadius ?? 0,
    // для берсерка:
    berserkerScaling: classData.berserkerScaling ?? false,

    // runtime:
    x: 0, y: 0,
    targetId: null,
    lastAttackTime: 0,
    lastHealTime: 0,
    poisonStacks: [],
    side: "ally"
  };
}
```

### 10.4 `js/game/systems/battleSystem.js`

**Изменения:**

1. **`chooseTarget`** — добавить фильтр `canHitFlying`:
```javascript
function chooseTarget(actor, targets) {
  const validTargets = actor.canHitFlying
    ? targets
    : targets.filter(t => t.movementType !== "flying");
  return keepCurrentTarget(actor, validTargets) ?? chooseClosestTarget(actor, validTargets);
}
```

2. **Обработка AoE-урона** — при попадании юнита с `splashRadius > 0`:
```javascript
function applyDamage(attacker, target, allEnemies, nowSeconds) {
  if (attacker.splashRadius > 0) {
    for (const enemy of allEnemies) {
      if (getDistance(target, enemy) <= attacker.splashRadius) {
        enemy.currentHealth -= attacker.attack;
        markHit(enemy, nowSeconds);
      }
    }
  } else {
    target.currentHealth -= attacker.attack;
    markHit(target, nowSeconds);
  }
}
```

3. **Камикадзе** — отдельная логика движения:
```javascript
function updateKamikaze(actor, enemies, allAllies, nowSeconds) {
  // Ищет цель в заднем ряду
  const backlineTargets = enemies.filter(e => e.formationRow === "back");
  const target = backlineTargets.length > 0
    ? chooseClosestTarget(actor, backlineTargets)
    : chooseClosestTarget(actor, enemies);

  // Не останавливается для боя (не проверяет attackRange)
  // Движется к цели

  // При контакте (getBodyGap < 0.5):
  if (target && getBodyGap(actor, target) < 0.5) {
    // Взрыв: урон всем врагам в explosionRadius
    for (const enemy of enemies) {
      if (getDistance(actor, enemy) <= actor.explosionRadius) {
        enemy.currentHealth -= actor.explosionDamage;
        markHit(enemy, nowSeconds);
      }
    }
    actor.currentHealth = 0; // Самоуничтожение
  }
}
```

4. **Берсерк** — модификатор атаки:
```javascript
function getEffectiveAttack(actor) {
  if (actor.berserkerScaling) {
    const hpRatio = actor.currentHealth / actor.maxHealth;
    const multiplier = 1 + 2 * (1 - hpRatio); // от ×1 до ×3
    return Math.round(actor.attack * multiplier);
  }
  return actor.attack;
}
```

5. **Паладин** — лечение каждые N секунд:
```javascript
function updateHealer(actor, allies, nowSeconds) {
  if (actor.healAmount <= 0) return;
  if (nowSeconds - actor.lastHealTime < actor.healInterval) return;

  // Найти ближайшего раненого союзника в радиусе
  let bestTarget = null;
  let lowestHpRatio = 1;
  for (const ally of allies) {
    if (ally.id === actor.id) continue;
    const dist = getDistance(actor, ally);
    if (dist > actor.healRadius) continue;
    const ratio = ally.currentHealth / ally.maxHealth;
    if (ratio < lowestHpRatio) {
      lowestHpRatio = ratio;
      bestTarget = ally;
    }
  }

  if (bestTarget && lowestHpRatio < 1) {
    bestTarget.currentHealth = Math.min(
      bestTarget.maxHealth,
      bestTarget.currentHealth + actor.healAmount
    );
    actor.lastHealTime = nowSeconds;
  }
}
```

6. **Яд (Отравитель)** — DoT при попадании:
```javascript
// При попадании отравителя:
if (attacker.poisonDps > 0) {
  target.poisonStacks.push({
    dps: attacker.poisonDps,
    endTime: nowSeconds + attacker.poisonDuration
  });
}

// Каждый тик для каждого юнита:
function applyPoison(actor, nowSeconds, dt) {
  actor.poisonStacks = actor.poisonStacks.filter(p => p.endTime > nowSeconds);
  const totalDps = actor.poisonStacks.reduce((sum, p) => sum + p.dps, 0);
  actor.currentHealth -= totalDps * dt;
}
```

7. **Проигрыш — сброс волны:**
```javascript
if (aliveAllies.length === 0 && aliveEnemies.length > 0) {
  // Золото за убитых уже начислено при их смерти
  // НЕ двигаем waveProgress — волна остаётся текущей
  // Юниты игрока уже мертвы (удалены из garrison/bridgehead при отправке в бой)
  state.battle.phase = "lost";
}
```

### 10.5 `js/game/physics/battlePhysics.js`

**Добавить категории:**
```javascript
const CATEGORY_FLYING_ALLY  = 0x0010;
const CATEGORY_FLYING_ENEMY = 0x0020;
```

**При создании тела юнита** — если `movementType === "flying"`:
```javascript
filterCategoryBits: isAlly ? CATEGORY_FLYING_ALLY : CATEGORY_FLYING_ENEMY,
filterMaskBits: CATEGORY_WALL | (isAlly ? CATEGORY_FLYING_ENEMY : CATEGORY_FLYING_ALLY)
// Летающие НЕ сталкиваются с наземными
```

**При создании тела камикадзе** — если `movementType === "kamikaze"`:
```javascript
filterCategoryBits: isAlly ? CATEGORY_ALLY : CATEGORY_ENEMY,
filterMaskBits: CATEGORY_WALL
// Камикадзе НЕ сталкиваются с врагами (проезжают мимо)
```

### 10.6 `js/game/systems/garrisonSystem.js`

**Добавить:**
- При переводе юнита из резерва в гарнизон — **модалка выбора класса** (фильтрованная по `minLevel` ≤ `unit.level`).
- При выставлении на плацдарм — **переключатель ряда** (`formationRow: "front" | "back"`).

**Модифицировать `stageUnitOnBridgehead`:**
```javascript
export function stageUnitOnBridgehead(state, unitId, classId, formationRow = "front") {
  const unit = state.garrison.find(u => u.id === unitId);
  if (!unit) return;

  const classConfig = getClassConfig(classId);
  if (unit.level < classConfig.minLevel) return; // Проверка ярус

  state.bridgehead.push({
    ...unit,
    class: classId,
    formationRow
  });
}
```

### 10.7 `js/ui/screens/garrisonScreen.js`

**Добавить:**
1. Модалка выбора класса при переводе из резерва: список доступных классов с иконками и описаниями.
2. На каждом слоте плацдарма — кнопка/переключатель `[ Передний | Задний ]`.

### 10.8 Новый файл: `data/classes.json` (опционально)

Вместо хранения классов в `unit-levels.json` можно вынести в отдельный файл для удобства балансировки.

---

## 11. Очерёдность реализации (Phases)

### Фаза 1: Минимальный прототип (3–5 дней)
1. Новый формат `waves.json` с группами по рядам
2. `formationRow` на плацдарме (UI-переключатель + спавн-оффсет)
3. Два класса: Мечник + Рыцарь (без AoE, без летающих)
4. Сброс волны при поражении + золото за убитых
5. Волны 1-1, 1-2 для теста

### Фаза 2: Контрпик-треугольник (3–5 дней)
1. Громила (AoE-механика в `battleSystem.js`)
2. Лучник (дальний бой, `attackRange`)
3. Модалка выбора класса при переводе в казарму
4. Волны 1-1 — 1-5

### Фаза 3: Летающие и камикадзе (3–5 дней)
1. Категории коллизий для летающих в `battlePhysics.js`
2. Фильтр `canHitFlying` в таргетинге
3. Логика камикадзе (игнор коллизий, взрыв)
4. Волны 1-4 — 1-7

### Фаза 4: Локация 2 (3–5 дней)
1. Щитоносец + Копейщик (новые классы, ярус 2)
2. Вражеские лучники и щитоносцы
3. Колесница-таран (камикадзе), стая ворон (летающая стая)
4. Волны 2-1 — 2-7
5. Повышение лимита мерджа после прохождения Локации 1

---

## 12. Критерии приёмки

1. ✅ Игрок может выбрать класс при переводе юнита в казарму (модалка с фильтрацией по уровню)
2. ✅ Игрок может назначить каждому юниту передний/задний ряд на плацдарме
3. ✅ Задний ряд вступает в бой на ~2 сек. позже переднего (визуально заметно)
4. ✅ Громила бьёт по площади (AoE-урон в радиусе)
5. ✅ Летающий враг пролетает мимо наземных мечников (нет коллизии)
6. ✅ Мечник НЕ может ударить летающего. Лучник — может
7. ✅ Камикадзе бежит мимо переднего ряда к заднему, взрывается, умирает
8. ✅ Камикадзе можно убить по дороге (лучниками)
9. ✅ При проигрыше: волна сброшена на 100% HP, юниты потеряны, золото за убитых начислено
10. ✅ Волна 1-5 (Камнемёт): толпа мечников гарантированно проигрывает, 1 Рыцарь гарантированно побеждает
