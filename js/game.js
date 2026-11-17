/* 文字探险 —— 游戏逻辑 */
(function () {
  "use strict";

  const START_MAX_LIFE = 100;
  const START_DEFENSE = 10;
  const START_COINS = 200;
  const MAX_DAYS = 30;

  // ---------- 纯逻辑（可单独测试） ----------

  /** 解析 CSV 文本（支持 BOM、引号、逗号转义），返回对象数组 */
  function parseCSV(text) {
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

    const nonEmpty = rows.filter(r => r.some(f => f.trim() !== ""));
    if (!nonEmpty.length) return [];
    const header = nonEmpty[0].map(h => h.trim());
    return nonEmpty.slice(1).map(r => {
      const obj = {};
      header.forEach((h, idx) => { obj[h] = (r[idx] || "").trim(); });
      return obj;
    });
  }

  function createState() {
    return {
      day: 0, life: START_MAX_LIFE, maxLife: START_MAX_LIFE, defense: START_DEFENSE,
      coins: START_COINS, exp: 0, over: false, won: false,
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
   */
  function applyEvent(state, event) {
    const s = Object.assign({}, state);
    const lifeRaw = String(event.life ?? "").trim().toLowerCase();
    let blocked = 0;
    if (lifeRaw === "full") {
      s.life = s.maxLife;
    } else {
      let d = num(lifeRaw);
      if (d < 0) {
        const reduced = Math.min(0, d + s.defense);
        blocked = reduced - d;
        d = reduced;
      }
      s.life = Math.min(s.maxLife, Math.max(0, s.life + d));
    }
    s.coins += num(event.coins);
    s.exp += Math.max(0, num(event.exp));
    changeMaxLife(s, num(event.maxlife));
    s.defense = Math.max(0, s.defense + num(event.defense));
    return {
      state: s,
      delta: {
        life: s.life - state.life, maxLife: s.maxLife - state.maxLife, defense: s.defense - state.defense,
        coins: s.coins - state.coins, exp: s.exp - state.exp, blocked,
      },
    };
  }

  /** 开启新的一天并结算事件 */
  function advanceDay(state, event) {
    const { state: s, delta } = applyEvent(Object.assign({}, state, { day: state.day + 1 }), event);
    if (s.life <= 0) { s.over = true; s.won = false; }
    else if (s.day >= MAX_DAYS) { s.over = true; s.won = true; }
    return { state: s, delta };
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
    START_MAX_LIFE, START_DEFENSE, START_COINS, MAX_DAYS, SHOP_ITEMS,
    parseCSV, createState, applyEvent, changeMaxLife, advanceDay, applyWrongAnswer, buyItem, shuffle, pickRandom,
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
  let events = [];
  let state = createState();
  let lastQuestion = null;
  let lastEvent = null;
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

  function renderStats() {
    $("stat-day").textContent = `${state.day} / ${MAX_DAYS}`;
    $("stat-life").textContent = `${state.life} / ${state.maxLife}`;
    $("stat-defense").textContent = state.defense;
    $("stat-coins").textContent = state.coins;
    $("stat-coins").classList.toggle("negative", state.coins < 0);
    $("stat-exp").textContent = state.exp;
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

  function addLog(text) {
    log.insertBefore(el("li", null, text), log.firstChild);
  }

  function showStart() {
    panel.replaceChildren(
      el("p", null, `欢迎来到文字探险！你有 ${START_MAX_LIFE} 点生命、${START_DEFENSE} 点防御、${START_COINS} 枚金币。防御可以抵挡受到的伤害。每开启新的一天都要先答对一道题，然后迎接当天的随机事件。下方的小商店可以随时用金币买防御和生命。坚持 ${MAX_DAYS} 天并活下来就能通关。`),
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
      } else {
        panel.appendChild(el("p", { class: "changes" }, "这次不罚，但连续答错会有惩罚哦。"));
      }
      if (state.over) {
        lose(state.life <= 0 ? "你的生命耗尽了……" : "你连续答错了 4 道题……");
      } else {
        panel.appendChild(el("button", { class: "primary", onclick: askQuestion }, "换一道题"));
      }
    }
  }

  function startDay() {
    const ev = pickRandom(events, lastEvent);
    lastEvent = ev;
    const result = advanceDay(state, ev);
    state = result.state;
    renderStats();

    const d = result.delta;
    const lifeText = String(ev.life).trim().toLowerCase() === "full" ? `生命回满(${signed(d.life)})` : `生命 ${signed(d.life)}`;
    const parts = [lifeText];
    if (d.blocked > 0) parts.push(`防御抵挡 ${d.blocked} 点伤害`);
    parts.push(`金币 ${signed(d.coins)}`, `经验 ${signed(d.exp)}`);
    if (d.maxLife) parts.push(`生命上限 ${signed(d.maxLife)}`);
    if (d.defense) parts.push(`防御 ${signed(d.defense)}`);
    const changes = parts.join("，");
    addLog(`第 ${state.day} 天：${ev.event}（${changes}）`);

    const nodes = [
      el("p", null, `第 ${state.day} 天`),
      el("p", { class: "question" }, ev.event),
      el("p", { class: "changes" }, changes),
    ];

    if (!state.over) {
      nodes.push(el("button", { class: "primary", onclick: askQuestion }, `开启第 ${state.day + 1} 天`));
    }
    panel.replaceChildren(...nodes);
    if (state.over && state.won) win();
    else if (state.over) lose("你的生命耗尽了……");
  }

  function finalStats() {
    return `生命 ${state.life}/${state.maxLife}，防御 ${state.defense}，金币 ${state.coins}，经验 ${state.exp}`;
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
    lastQuestion = lastEvent = null;
    wrongStreak = 0;
    shopMsg = "";
    log.replaceChildren();
    renderStats();
    showStart();
  }

  async function loadCSV(path) {
    const res = await fetch(path);
    if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
    return parseCSV(await res.text());
  }

  async function init() {
    renderStats();
    panel.replaceChildren(el("p", null, "正在加载题目和事件……"));
    try {
      [questions, events] = await Promise.all([loadCSV("questions.csv"), loadCSV("event.csv")]);
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
