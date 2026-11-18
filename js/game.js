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
   * - maxlife：按 changeMaxLife 的规则处理生命；defense：直接翻倍 / 减半
   * - coins：负数时 double 视为 nodebt，half 不起作用
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
      else if (coinOp === "double") s.coins *= 2;
      else s.coins = halve(s.coins);
    } else if (setTarget(event.coins) !== null) s.coins = capTo(s.coins, event.coins);
    else s.coins += num(event.coins);
    s.exp += Math.max(0, num(event.exp));
    const maxOp = special(event.maxlife);
    if (maxOp === "double") changeMaxLife(s, s.maxLife);
    else if (maxOp === "half") changeMaxLife(s, halve(s.maxLife) - s.maxLife);
    else if (setTarget(event.maxlife) !== null) changeMaxLife(s, capTo(s.maxLife, event.maxlife) - s.maxLife);
    else changeMaxLife(s, num(event.maxlife));
    const defOp = special(event.defense);
    if (defOp === "double") s.defense *= 2;
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
    parseCSV, parseRows, parseQuestions, decodeText, createState, setTarget, special, applyEvent, changeMaxLife, advanceDay, applyWrongAnswer, buyItem, shuffle, pickRandom,
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
    const ev = pickRandom(events, lastEvent);
    lastEvent = ev;
    const result = advanceDay(state, ev);
    state = result.state;
    renderStats();

    const d = result.delta;
    const lifeLabel = { full: "生命回满", double: "生命翻倍", half: "生命减半" }[String(ev.life).trim().toLowerCase()];
    const lifeText = lifeLabel ? `${lifeLabel}(${signed(d.life)})` : `生命 ${signed(d.life)}`;
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
