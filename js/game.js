/* 冒险30天 —— 游戏逻辑 */
(function () {
  "use strict";

  const START_MAX_LIFE = 100;
  const START_DEFENSE = 10;
  const START_COINS = 200;
  const MAX_DAYS = 30;

  // ---------- 纯逻辑（可单独测试） ----------

  /** 把 CSV 文本解析成二维数组（支持 BOM、引号、逗号转义、CRLF） */
  function parseRows(text) {
    text = text.replace(/^﻿/, "");
    const rows = [];
    let row = [];
    let field = "";
    let inQuotes = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (inQuotes) {
        if (c === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; }
          else inQuotes = false;
        } else field += c;
      } else if (c === '"') {
        inQuotes = true;
      } else if (c === ",") {
        row.push(field); field = "";
      } else if (c === "\n" || c === "\r") {
        if (c === "\r" && text[i + 1] === "\n") i++;
        row.push(field); field = "";
        rows.push(row); row = [];
      } else field += c;
    }
    if (field !== "" || row.length) { row.push(field); rows.push(row); }

    return rows;
  }

  /** 解析带表头的 CSV，返回对象数组 */
  function parseCSV(text) {
    const rows = parseRows(text);
    const nonEmpty = rows.filter(r => r.some(f => f.trim() !== ""));
    if (!nonEmpty.length) return [];
    const header = nonEmpty[0].map(h => h.trim());
    return nonEmpty.slice(1).map(r => {
      const obj = {};
      header.forEach((h, idx) => { obj[h] = (r[idx] || "").trim(); });
      return obj;
    });
  }

  /**
   * 解析题库 CSV：每行 5 列（题干、答案、干扰项1、干扰项2、干扰项3）。
   * 按列的位置读取；表头行（第一格是“题干”或“Question”）会自动跳过；不满 5 列或有空格的行跳过；
   * 整行没有英文逗号时，用中文逗号“，”作为后备分隔符。
   */
  function parseQuestions(text) {
    const out = [];
    for (let r of parseRows(text)) {
      if (r.length === 1 && r[0].includes("，")) r = r[0].split("，");
      r = r.map(x => x.trim());
      if (r.length < 5 || r.slice(0, 5).some(x => x === "")) continue;
      if (/^(question|题干|题目|问题)$/i.test(r[0])) continue;
      out.push({ Question: r[0], Answer: r[1], Distractor1: r[2], Distractor2: r[3], Distractor3: r[4] });
    }
    return out;
  }

  /** 自动识别 UTF-8 / GBK（Excel 中文另存为 CSV 常是 GBK） */
  function decodeText(buffer) {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    } catch (e) {
      try { return new TextDecoder("gbk").decode(buffer); }
      catch (e2) { return new TextDecoder("utf-8").decode(buffer); }
    }
  }

  function createState() {
    return {
      day: 0, life: START_MAX_LIFE, maxLife: START_MAX_LIFE, defense: START_DEFENSE,
      coins: START_COINS, exp: 0, level: 1, over: false, won: false,
      antidotes: [], // 每瓶解药最后有效的那一天
      poison: [], // 每次中毒剩余的回数（可叠加）
    };
  }

  /** 把 CSV 里的数值转成整数，空白或非数字视为 0 */
  function num(v) {
    const n = parseInt(String(v ?? "").trim(), 10);
    return isNaN(n) ? 0 : n;
  }

  /**
   * 改变生命上限（直接修改 s）：
   * - 满血时：上限变化后仍是满血；
   * - 不满血时：不回血，生命只在超过新上限时被压到上限。
   */
  /**
   * 解析 "set N" 写法（大小写、空格都可以，如 "set 10"、"SET10"），返回 N；不是 set 写法则返回 null。
   */
  function setTarget(v) {
    const m = /^set\s*(-?\d+)$/i.exec(String(v ?? "").trim());
    return m ? parseInt(m[1], 10) : null;
  }

  /** 若当前值大于 N 则压到 N，否则不变 */
  function capTo(current, v) {
    const t = setTarget(v);
    return t !== null && current > t ? t : current;
  }

  /** 返回 "double" / "half" / "nodebt"（不分大小写），否则返回 null */
  function special(v) {
    const t = String(v ?? "").trim().toLowerCase();
    return t === "double" || t === "half" || t === "nodebt" ? t : null;
  }

  /** 减半，奇数向上取整（没有 0.5） */
  function halve(n) { return Math.ceil(n / 2); }

  function changeMaxLife(s, d) {
    if (!d) return;
    const wasFull = s.life >= s.maxLife;
    s.maxLife = Math.max(1, s.maxLife + d);
    s.life = wasFull ? s.maxLife : Math.min(s.life, s.maxLife);
  }

  /**
   * 把事件应用到状态上，返回新状态和实际变化量。按顺序结算：
   * 1. life：数字为增减，"full" 为回满；负数先加上防御值（最多减到 0，不会变成回血）；
   *    不超过上限，不低于 0
   * 2. coins：可为负（负债）；exp：只增不减（负数视为 0）
   * 3. maxlife：生命上限增减，规则见 changeMaxLife
   * 4. defense：防御增减，最低为 0
   * 以上 life、coins、maxlife、defense 都可以写 "set N"：只有当前值大于 N 时才变成 N，否则不变。
   * set 生命不受防御影响；set 生命上限按 changeMaxLife 的规则处理生命。
   * 也可以写 double（翻倍）/ half（减半，奇数向上取整）：
   * - life：翻倍不超过当前上限；减半不受防御影响
   * - maxlife：按 changeMaxLife 的规则处理生命；defense：直接翻倍 / 减半，为 0 时 double 视为 +30
   * - coins：负数时 double 视为 nodebt，half 不起作用；为 0 时 double 视为 +100
   * coins 还可以写 nodebt：负数时归零（免除债务），否则视为 +30。
   */
  function applyEvent(state, event) {
    const s = Object.assign({}, state);
    const lifeRaw = String(event.life ?? "").trim().toLowerCase();
    let blocked = 0;
    if (lifeRaw === "full") {
      s.life = s.maxLife;
    } else if (lifeRaw === "double") {
      s.life = Math.min(s.maxLife, s.life * 2);
    } else if (lifeRaw === "half") {
      s.life = halve(s.life);
    } else if (setTarget(lifeRaw) !== null) {
      s.life = Math.max(0, capTo(s.life, lifeRaw));
    } else {
      let d = num(lifeRaw);
      if (d < 0) {
        const reduced = Math.min(0, d + s.defense);
        blocked = reduced - d;
        d = reduced;
      }
      s.life = Math.min(s.maxLife, Math.max(0, s.life + d));
    }
    const coinOp = special(event.coins);
    if (coinOp) {
      if (s.coins < 0) {
        if (coinOp !== "half") s.coins = 0; // nodebt / double：免除债务
      } else if (coinOp === "nodebt") s.coins += 30;
      else if (coinOp === "double") s.coins = s.coins === 0 ? 100 : s.coins * 2;
      else s.coins = halve(s.coins);
    } else if (setTarget(event.coins) !== null) s.coins = capTo(s.coins, event.coins);
    else s.coins += num(event.coins);
    const expRaw = String(event.exp ?? "").trim().toLowerCase();
    // full：经验补到下一级所需，即升一级；double：经验翻倍（0 时 +5），但最多补到下一级所需（触及升级门槛就视为 full）
    if (expRaw === "full") s.exp = Math.max(s.exp, expForLevel((s.level || 1) + 1));
    else if (expRaw === "double") s.exp = Math.min(s.exp === 0 ? 5 : s.exp * 2, Math.max(s.exp, expForLevel((s.level || 1) + 1)));
    else s.exp += Math.max(0, num(event.exp));
    const maxOp = special(event.maxlife);
    if (maxOp === "double") changeMaxLife(s, s.maxLife);
    else if (maxOp === "half") changeMaxLife(s, halve(s.maxLife) - s.maxLife);
    else if (setTarget(event.maxlife) !== null) changeMaxLife(s, capTo(s.maxLife, event.maxlife) - s.maxLife);
    else changeMaxLife(s, num(event.maxlife));
    const defOp = special(event.defense);
    if (defOp === "double") s.defense = s.defense === 0 ? 30 : s.defense * 2;
    else if (defOp === "half") s.defense = halve(s.defense);
    else if (setTarget(event.defense) !== null) s.defense = Math.max(0, capTo(s.defense, event.defense));
    else s.defense = Math.max(0, s.defense + num(event.defense));
    return {
      state: s,
      delta: {
        life: s.life - state.life, maxLife: s.maxLife - state.maxLife, defense: s.defense - state.defense,
        coins: s.coins - state.coins, exp: s.exp - state.exp, blocked,
      },
    };
  }

  /**
   * 等级：升到 L 级所需的累计经验 = 30 + 15 × (L-1) × (L-2)，即 2 级 30、3 级 60、4 级 120、5 级 210、6 级 330……
   * （从 2 级起，每级所需经验比上一级多 30。）升到 N 级时：生命上限 +N×5（按上限规则处理生命，不回血），防御 +N×2。
   * 当天事件让生命归零时不升级（游戏已经结束）。
   */
  const LEVEL_MAX_LIFE = 5;  // × 新等级
  const LEVEL_DEFENSE = 2;   // × 新等级

  function expForLevel(level) {
    return level <= 1 ? 0 : 30 + 15 * (level - 1) * (level - 2);
  }

  function levelForExp(exp) {
    let level = 1;
    while (exp >= expForLevel(level + 1)) level++;
    return level;
  }

  /** 按经验升级（直接修改 s），返回升了几级 */
  function applyLevelUps(s) {
    const target = levelForExp(s.exp);
    const gained = Math.max(0, target - s.level);
    for (let lv = s.level + 1; lv <= target; lv++) {
      changeMaxLife(s, LEVEL_MAX_LIFE * lv);
      s.defense += LEVEL_DEFENSE * lv;
    }
    s.level = Math.max(s.level, target);
    return gained;
  }

  /**
   * 中毒：事件的 poisoned 栏为 1 时中毒，从下一天开始持续 3 天，每天生命固定 -10（不受防御阻挡）。
   * 中毒期间再次中毒会叠加（两层就是每天 -20）。中毒扣血在当天所有其它效果之前结算；
   * 毒发让生命归零时游戏直接失败，当天的事件不再发生。
   */
  const POISON_DAMAGE = 10;
  const POISON_DAYS = 3;
  /**
   * 解药：事件的 antidote 栏为 1 时获得一瓶解药（填几就是几瓶，可叠加）。
   * - 获得时正处于中毒状态：立刻解毒（所有中毒层都结束），当天不扣中毒的血，用掉一瓶。
   * - 获得时没有中毒：持有 4 天（之后的 4 天内有效）。这期间碰到 poisoned 事件不会中毒，解药 -1。
   */
  const ANTIDOTE_DAYS = 4;

  /** 开启新的一天：先结算中毒，再结算事件 */
  function advanceDay(state, event) {
    const start = Object.assign({}, state, { day: state.day + 1 });
    const day = start.day;
    start.antidotes = (state.antidotes || []).filter(last => last >= day);
    let antidoteGain = Math.max(0, num(event.antidote));
    let stacks = state.poison || [];
    const cured = antidoteGain > 0 && stacks.length > 0;
    if (cured) { stacks = []; antidoteGain--; }
    const poisonDamage = Math.min(start.life, POISON_DAMAGE * stacks.length);
    start.life -= poisonDamage;
    start.poison = stacks.map(n => n - 1).filter(n => n > 0);
    if (stacks.length && start.life <= 0) {
      start.over = true; start.won = false;
      const zero = { life: 0, maxLife: 0, defense: 0, coins: 0, exp: 0, blocked: 0 };
      return { state: start, delta: zero, levelUp: null, poisonDamage, poisonDeath: true, poisoned: false, poisonBlocked: false, cured: false, antidoteGain: 0 };
    }
    const { state: s, delta } = applyEvent(start, event);
    let poisoned = num(event.poisoned) === 1, poisonBlocked = false;
    if (poisoned && s.antidotes.length) {
      s.antidotes = s.antidotes.slice().sort((a, b) => a - b).slice(1); // 用掉最早过期的那瓶
      poisoned = false; poisonBlocked = true;
    }
    if (poisoned) s.poison = s.poison.concat(POISON_DAYS);
    if (antidoteGain) s.antidotes = s.antidotes.concat(Array(antidoteGain).fill(day + ANTIDOTE_DAYS));
    const lifeBefore = s.life, maxBefore = s.maxLife, defBefore = s.defense;
    const levels = s.life > 0 ? applyLevelUps(s) : 0;
    const levelUp = levels ? { levels, level: s.level, life: s.life - lifeBefore, maxLife: s.maxLife - maxBefore, defense: s.defense - defBefore } : null;
    if (s.life <= 0) { s.over = true; s.won = false; }
    else if (s.day >= MAX_DAYS) { s.over = true; s.won = true; }
    return { state: s, delta, levelUp, poisonDamage, poisonDeath: false, poisoned, poisonBlocked, cured, antidoteGain };
  }

  /**
   * 连续答错惩罚（streak 为本次答错后的连错次数）：
   * 1 题不罚；2 题扣 10 金币；3 题扣 10 生命（不受防御影响）；4 题直接失败。
   */
  function applyWrongAnswer(state, streak) {
    const s = Object.assign({}, state);
    let penalty = "";
    if (streak === 2) {
      s.coins -= 10;
      penalty = "连续答错 2 题，扣除 10 枚金币。";
    } else if (streak === 3) {
      s.life = Math.max(0, s.life - 10);
      penalty = "连续答错 3 题，扣除 10 点生命。";
    } else if (streak >= 4) {
      s.over = true; s.won = false;
      penalty = "连续答错 4 题，冒险到此结束。";
    }
    if (s.life <= 0) { s.over = true; s.won = false; }
    return { state: s, penalty };
  }

  /** 商店商品 */
  const SHOP_ITEMS = [
    { id: "def5", type: "defense", amount: 5, price: 100 },
    { id: "def10", type: "defense", amount: 10, price: 180 },
    { id: "def15", type: "defense", amount: 15, price: 270 },
    { id: "life10", type: "life", amount: 10, price: 100 },
    { id: "life20", type: "life", amount: 20, price: 180 },
    { id: "life30", type: "life", amount: 30, price: 270 },
  ];

  /**
   * 购买商品。仅当游戏进行中且生命大于 0 时可买；金币必须足够（不能借钱买）；
   * 买生命时不超过生命上限，满血时不能买生命。
   */
  function buyItem(state, item) {
    if (state.over || state.life <= 0) return { ok: false, state, reason: "生命为 0 时不能购买。" };
    if (state.coins < item.price) return { ok: false, state, reason: "金币不足。" };
    if (item.type === "life" && state.life >= state.maxLife) return { ok: false, state, reason: "生命已满，不需要购买。" };
    const s = Object.assign({}, state);
    s.coins -= item.price;
    if (item.type === "defense") s.defense += item.amount;
    else s.life = Math.min(s.maxLife, s.life + item.amount);
    return { ok: true, state: s, gained: item.type === "defense" ? s.defense - state.defense : s.life - state.life };
  }

  /**
   * 事件链：next 栏填下一个事件的编号（SN），抽到这个事件后，第二天必定发生 next 指向的事件；
   * 0 或空白表示没有后续，第二天照常随机。
   * prev 栏填前一个事件的编号：不是 0 的事件只会通过事件链出现，不会被随机抽到。
   */
  function findEvent(events, sn) {
    const key = String(sn ?? "").trim();
    if (!key || key === "0") return null;
    return events.find(e => String(e.SN).trim() === key) || null;
  }

  /**
   * 可随机抽取的事件：prev 为 0，且整条事件链能在剩下的天数内走完。
   * 链的长度看链上第一个事件的 linkcount 栏（0 视为 1，即单个事件）。
   * day 是将要开始的那一天，剩余天数 = MAX_DAYS - day + 1（含当天）。例如三连事件最晚第 28 天抽到，第 29 天不会抽到。
   */
  function randomPool(events, day) {
    const hasPrev = e => { const k = String(e.prev ?? "").trim(); return k !== "" && k !== "0"; };
    const daysLeft = day ? MAX_DAYS - day + 1 : Infinity;
    const pool = events.filter(e => !hasPrev(e) && Math.max(1, num(e.linkcount)) <= daysLeft);
    if (pool.length) return pool;
    const fallback = events.filter(e => !hasPrev(e));
    return fallback.length ? fallback : events;
  }

  function shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  /** 随机取一个元素，尽量避免与上一次相同 */
  function pickRandom(list, last) {
    if (list.length <= 1) return list[0];
    let item;
    do { item = list[Math.floor(Math.random() * list.length)]; } while (item === last);
    return item;
  }

  const Logic = {
    START_MAX_LIFE, START_DEFENSE, START_COINS, MAX_DAYS, SHOP_ITEMS, POISON_DAMAGE, POISON_DAYS, ANTIDOTE_DAYS,
    parseCSV, parseRows, parseQuestions, decodeText, createState, setTarget, special, applyEvent, findEvent, randomPool, changeMaxLife, expForLevel, levelForExp, applyLevelUps, advanceDay, applyWrongAnswer, buyItem, shuffle, pickRandom,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = Logic;
  }
  if (typeof document === "undefined") return;

  // ---------- 界面 ----------

  const $ = id => document.getElementById(id);
  const panel = $("panel");
  const log = $("log");

  let questions = [];
  let questionSource = "questions.csv";
  let isDefaultBank = true; // 还是自带的 questions.csv，没有导入别的
  let homework = null;      // 通过作业链接打开时：{ title, questions }
  let events = [];
  let state = createState();
  let lastQuestion = null;
  let lastEvent = null;
  let pendingEvent = null;
  let wrongStreak = 0;

  function el(tag, attrs, text) {
    const e = document.createElement(tag);
    Object.entries(attrs || {}).forEach(([k, v]) => {
      if (k === "onclick") e.addEventListener("click", v);
      else e.setAttribute(k, v);
    });
    if (text != null) e.textContent = text;
    return e;
  }

  function signed(n) { return (n > 0 ? "+" : "") + n; }

  /** 把文字里带正负号的数字包成彩色 span：正数绿色，负数红色（0 不带符号，不变色） */
  function colorize(text) {
    return text.split(/([+-]\d+)/).filter(Boolean).map(part =>
      /^[+-]\d+$/.test(part) ? el("span", { class: part[0] === "+" ? "num-pos" : "num-neg" }, part) : document.createTextNode(part));
  }

  function renderStats() {
    $("stat-day").textContent = `${state.day} / ${MAX_DAYS}`;
    $("stat-life").textContent = `${state.life} / ${state.maxLife}`;
    $("stat-defense").textContent = state.defense;
    $("stat-coins").textContent = state.coins;
    $("stat-coins").classList.toggle("negative", state.coins < 0);
    $("stat-level").textContent = `Lv ${state.level}`;
    $("stat-exp").textContent = `${state.exp} / ${expForLevel(state.level + 1)}`;
    renderShop();
  }

  // ---------- 商店 ----------

  let shopMsg = "";

  function itemLabel(item) {
    return `${item.type === "defense" ? "防御" : "生命"} +${item.amount}（${item.price} 金币）`;
  }

  function renderShop() {
    const box = $("shop-items");
    if (!box) return;
    box.replaceChildren(...SHOP_ITEMS.map(item => {
      const disabled = state.over || state.life <= 0 || state.coins < item.price ||
        (item.type === "life" && state.life >= state.maxLife);
      const b = el("button", { class: "shop-item " + item.type, onclick: () => buy(item) }, itemLabel(item));
      b.disabled = disabled;
      return b;
    }));
    $("shop-msg").textContent = shopMsg;
  }

  function buy(item) {
    const r = buyItem(state, item);
    if (!r.ok) {
      shopMsg = r.reason;
    } else {
      state = r.state;
      const what = item.type === "defense" ? "防御" : "生命";
      shopMsg = `购买成功：${what} +${r.gained}，花费 ${item.price} 金币。`;
      addLog(`商店：${what} +${r.gained}（-${item.price} 金币）`);
    }
    renderStats();
  }

  function addLog(...parts) {
    const li = el("li");
    li.append(...parts);
    log.insertBefore(li, log.firstChild);
  }

  function showStart() {
    panel.replaceChildren(
      el("p", null, `欢迎来到冒险30天！你有 ${START_MAX_LIFE} 点生命、${START_DEFENSE} 点防御、${START_COINS} 枚金币。防御可以抵挡受到的伤害。每开启新的一天都要先答对一道题，然后迎接当天的随机事件。下方的小商店可以随时用金币买防御和生命。坚持 ${MAX_DAYS} 天并活下来就能通关。`),
      el("button", { class: "primary", onclick: askQuestion }, "开启第 1 天")
    );
  }

  function askQuestion() {
    const q = pickRandom(questions, lastQuestion);
    lastQuestion = q;
    const options = shuffle([q.Answer, q.Distractor1, q.Distractor2, q.Distractor3].filter(Boolean));
    const box = el("div", { class: "options" });
    options.forEach(opt => {
      box.appendChild(el("button", { onclick: () => answer(q, opt, box) }, opt));
    });
    panel.replaceChildren(
      el("p", null, `想要开启第 ${state.day + 1} 天，请先回答问题：`),
      el("p", { class: "question" }, q.Question),
      box
    );
  }

  function answer(q, chosen, box) {
    const buttons = Array.from(box.querySelectorAll("button"));
    buttons.forEach(b => {
      b.disabled = true;
      if (b.textContent === q.Answer) b.classList.add("correct");
      else if (b.textContent === chosen) b.classList.add("wrong");
    });

    if (chosen === q.Answer) {
      wrongStreak = 0;
      panel.appendChild(el("p", { class: "result-good" }, "回答正确！新的一天开始了。"));
      panel.appendChild(el("button", { class: "primary", onclick: startDay }, "继续"));
    } else {
      wrongStreak++;
      const result = applyWrongAnswer(state, wrongStreak);
      state = result.state;
      renderStats();
      panel.appendChild(el("p", { class: "result-bad" }, `回答错误，正确答案是：${q.Answer}。`));
      if (result.penalty) {
        panel.appendChild(el("p", { class: "result-bad" }, result.penalty));
        addLog(`第 ${state.day + 1} 天前：${result.penalty}`);
      }
      // 提醒下一题答错的后果
      const warnings = { 1: "这次不罚。⚠️ 再错一题将扣 10 金币。", 2: "⚠️ 再错一题将扣 10 生命值。", 3: "⚠️ 再错一题游戏将直接结束！" };
      if (!state.over && warnings[wrongStreak]) {
        panel.appendChild(el("p", { class: "warning" }, warnings[wrongStreak]));
      }
      if (state.over) {
        lose(state.life <= 0 ? "你的生命耗尽了……" : "你连续答错了 4 道题……");
      } else {
        panel.appendChild(el("button", { class: "primary", onclick: askQuestion }, "换一道题"));
      }
    }
  }

  function startDay() {
    const ev = pendingEvent || pickRandom(randomPool(events, state.day + 1), lastEvent);
    lastEvent = ev;
    pendingEvent = findEvent(events, ev.next);
    const result = advanceDay(state, ev);
    state = result.state;
    renderStats();

    const d = result.delta;
    if (result.poisonDeath) {
      const msg = `毒发：生命 ${signed(-result.poisonDamage)}`;
      addLog(`第 ${state.day} 天：`, ...colorize(msg));
      const c = el("p", { class: "changes" }); c.append("☠️ ", ...colorize(msg));
      panel.replaceChildren(el("p", null, `第 ${state.day} 天`), c);
      lose("你毒发身亡了……");
      return;
    }
    const lifeLabel = { full: "生命回满", double: "生命翻倍", half: "生命减半" }[String(ev.life).trim().toLowerCase()];
    const lifeText = lifeLabel ? `${lifeLabel}(${signed(d.life)})` : `生命 ${signed(d.life)}`;
    const parts = [];
    if (result.cured) parts.push("解药解毒，中毒结束");
    if (result.poisonDamage) parts.push(`毒发 ${signed(-result.poisonDamage)}`);
    parts.push(lifeText);
    if (d.blocked > 0) parts.push(`防御抵挡 ${d.blocked} 点伤害`);
    parts.push(`金币 ${signed(d.coins)}`, `经验 ${signed(d.exp)}`);
    if (d.maxLife) parts.push(`生命上限 ${signed(d.maxLife)}`);
    if (d.defense) parts.push(`防御 ${signed(d.defense)}`);
    if (result.poisoned) parts.push(`中毒！之后 ${POISON_DAYS} 天每天生命 -${POISON_DAMAGE}`);
    if (result.poisonBlocked) parts.push("解药抵挡了中毒（解药 -1）");
    if (result.antidoteGain) parts.push(`获得解药 +${result.antidoteGain}（之后 ${ANTIDOTE_DAYS} 天内可抵挡中毒）`);
    if (state.antidotes.length) parts.push(`持有解药 ${state.antidotes.length} 瓶`);
    const changes = parts.join("，");
    addLog(`第 ${state.day} 天：${ev.event}（`, ...colorize(changes), "）");

    const nodes = [
      el("p", null, `第 ${state.day} 天`),
      el("p", { class: "question" }, ev.event),
      (() => { const c = el("p", { class: "changes" }); c.append(...colorize(changes)); return c; })(),
    ];
    if (result.levelUp) {
      const u = result.levelUp;
      const up = `升级！你升到了 ${u.level} 级：生命上限 ${signed(u.maxLife)}，防御 ${signed(u.defense)}` + (u.life ? `，生命 ${signed(u.life)}` : "");
      const p = el("p", { class: "level-up" }); p.append("⭐ ", ...colorize(up));
      nodes.push(p);
      addLog("⭐ ", ...colorize(up));
    }

    if (!state.over) {
      nodes.push(el("button", { class: "primary", onclick: askQuestion }, `开启第 ${state.day + 1} 天`));
    }
    panel.replaceChildren(...nodes);
    if (state.over && state.won) win();
    else if (state.over) lose("你的生命耗尽了……");
  }

  function finalStats() {
    return `等级 ${state.level}，生命 ${state.life}/${state.maxLife}，防御 ${state.defense}，金币 ${state.coins}，经验 ${state.exp}`;
  }

  function win() {
    addLog("成功通关！");
    endGame(true, "🎉 恭喜通关！", `你成功度过了 ${MAX_DAYS} 天！最终：${finalStats()}。`);
  }

  function lose(reason) {
    addLog("游戏失败。");
    endGame(false, "游戏结束", `${reason}你坚持了 ${state.day} 天。最终：${finalStats()}。`);
  }

  /** 游戏结束：面板留一个重开按钮，并弹出需手动关闭的弹窗 */
  function endGame(won, title, text) {
    panel.appendChild(el("button", { class: "primary", onclick: restart }, "再来一局"));
    showModal(won, title, text);
  }

  function showModal(won, title, text) {
    const modal = $("modal");
    $("modal-box").className = "modal-box " + (won ? "win" : "lose");
    $("modal-title").textContent = title;
    $("modal-text").textContent = text;
    modal.hidden = false;
    $("modal-again").focus();
  }

  function hideModal() { $("modal").hidden = true; }

  $("modal-close").addEventListener("click", hideModal);
  $("modal-again").addEventListener("click", () => { hideModal(); restart(); });

  function restart() {
    state = createState();
    lastQuestion = lastEvent = pendingEvent = null;
    wrongStreak = 0;
    shopMsg = "";
    log.replaceChildren();
    renderStats();
    showStart();
  }

  // ---------- 导入题库 ----------

  function toast(msg) {
    const t = $("toast");
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => t.classList.remove("show"), 2600);
  }

  function renderQuestionInfo() {
    $("qbank-info").textContent = homework
      ? `📘 作业：${homework.title}（${questions.length} 题）`
      : `当前题库：${questionSource}（${questions.length} 题）`;
  }

  $("btn-import").addEventListener("click", () => $("file-input").click());
  $("file-input").addEventListener("change", async () => {
    const input = $("file-input");
    const file = input.files[0];
    input.value = "";
    if (!file) return;
    const parsed = parseQuestions(decodeText(await file.arrayBuffer()));
    const n = parsed.length;
    if (!n) { toast("❌ 未识别到题目，请检查 CSV 格式（点“📋 题库格式”查看说明）"); return; }
    questions = parsed;
    questionSource = file.name;
    isDefaultBank = false;
    lastQuestion = null;
    renderQuestionInfo();
    toast(`✅ 已导入题库「${file.name}」，共 ${n} 题`);
  });

  $("btn-format").addEventListener("click", () => { $("format-modal").hidden = false; });
  $("format-close").addEventListener("click", () => { $("format-modal").hidden = true; });
  $("format-template").addEventListener("click", () => {
    // UTF-8 BOM lets Excel open non-ASCII text correctly
    const blob = new Blob(["\uFEFF题干,答案,干扰项1,干扰项2,干扰项3\r\n"], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "questions-template.csv";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    toast("已下载空白模板");
  });

  // ---------- 发布作业（不记成绩） ----------
  const toRow = q => [q.Question, q.Answer, q.Distractor1, q.Distractor2, q.Distractor3];
  const fromRow = r => ({ Question: r[0], Answer: r[1], Distractor1: r[2], Distractor2: r[3], Distractor3: r[4] });

  $("btn-publish").addEventListener("click", () => {
    $("publish-modal").hidden = false;
    Homework.renderPublish($("publish-box"), {
      questions: questions.map(toRow), source: questionSource, isDefault: isDefaultBank,
      onClose: () => { $("publish-modal").hidden = true; },
    });
  });

  async function loadCSV(path) {
    const res = await fetch(path);
    if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
    return parseCSV(await res.text());
  }

  async function init() {
    // 作业链接：用链接里的题目（或默认题库），学生不能换题库
    homework = Homework.fromLocation();
    if (homework && homework.error) { toast(homework.message); homework = null; }
    if (homework) {
      document.body.classList.add("hw-mode");
      document.title = `${homework.title} · ${document.title}`;
    }
    const hwQuestions = homework && homework.questions;
    renderStats();
    panel.replaceChildren(el("p", null, "正在加载题目和事件……"));
    try {
      const [qBuf, evs] = await Promise.all([
        hwQuestions ? null : fetch("questions.csv").then(r => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`questions.csv: HTTP ${r.status}`)))),
        loadCSV("event.csv"),
      ]);
      questions = hwQuestions ? hwQuestions.map(fromRow) : parseQuestions(decodeText(qBuf));
      events = evs;
      renderQuestionInfo();
      if (!questions.length || !events.length) throw new Error("questions.csv 或 event.csv 为空");
      showStart();
    } catch (err) {
      panel.replaceChildren(
        el("p", { class: "result-bad" }, "无法加载 questions.csv / event.csv。"),
        el("p", null, "浏览器直接打开本地文件时无法读取 CSV，请在项目目录运行 `python3 -m http.server` 后访问 http://localhost:8000，或使用 GitHub Pages。"),
        el("p", { class: "changes" }, String(err))
      );
    }
  }

  init();
})();
