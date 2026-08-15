/* Проверка логики reminders.js — кому и что шлём вечером. Зависимостей нет. */
const r = require("./reminders");

let failures = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log((ok ? "  ok   " : "  FAIL ") + name + (ok ? "" : "\n         ожидалось " + JSON.stringify(expected) + ", получено " + JSON.stringify(actual)));
}

const TODAY = "2026-08-15";
const YESTERDAY = "2026-08-14";
const LONG_AGO = "2026-08-01";

function daily(id, done, extra) {
  return Object.assign({ id, title: "Задание " + id, type: "daily", done: !!done, category: "health" }, extra || {});
}
function st(over) {
  return Object.assign({ quests: [], streak: 0, lastActiveDate: TODAY, lastCompletionDate: null }, over);
}
function typeOf(state) {
  const d = r.decideReminder(state, TODAY);
  return d ? d.type : null;
}

console.log("\n— базовые случаи —");
check("всё закрыто сегодня → молчим",
  typeOf(st({ quests: [daily("a", true), daily("b", true)] })), null);
check("есть незакрытое → обычное напоминание",
  typeOf(st({ quests: [daily("a", true), daily("b", false)] })), "daily");
check("дневных заданий нет вообще → молчим",
  typeOf(st({ quests: [{ id: "x", type: "oneoff", done: false }] })), null);
check("день уже засчитан → молчим даже при незакрытых",
  typeOf(st({ quests: [daily("a", false)], lastCompletionDate: TODAY })), null);

console.log("\n— тот, кто сегодня не заходил —");
check("галочки вчерашние → считаем всё незакрытым",
  typeOf(st({ quests: [daily("a", true), daily("b", true)], lastActiveDate: YESTERDAY })), "daily");

console.log("\n— стрик —");
check("живой стрик, последний закрытый день вчера → предупреждение о стрике",
  typeOf(st({ quests: [daily("a", false)], streak: 5, lastCompletionDate: YESTERDAY })), "streak");
check("стрик 1 (слишком мало, чтобы пугать) → обычное напоминание",
  typeOf(st({ quests: [daily("a", false)], streak: 1, lastCompletionDate: YESTERDAY })), "daily");
check("стрик есть, но серия оборвалась давно → обычное напоминание, не паника",
  typeOf(st({ quests: [daily("a", false)], streak: 9, lastCompletionDate: LONG_AGO })), "daily");
check("стрик и всё закрыто → молчим",
  typeOf(st({ quests: [daily("a", true)], streak: 9, lastCompletionDate: TODAY })), null);

console.log("\n— заблокированные задания не считаются —");
check("незакрыто только заблокированное → молчим",
  typeOf(st({
    quests: [daily("a", true), daily("b", false, { requires: "gate" }), { id: "gate", type: "oneoff", done: false }]
  })), null);
check("предусловие выполнено → задание снова считается",
  typeOf(st({
    quests: [daily("a", true), daily("b", false, { requires: "gate" }), { id: "gate", type: "oneoff", done: true }]
  })), "daily");

console.log("\n— склонение дней в тексте стрика —");
// Стрик 1 сюда не попадает намеренно: сообщение про стрик начинается с двойки (см. выше).
[[2, "дня"], [4, "дня"], [5, "дней"], [11, "дней"], [12, "дней"], [14, "дней"], [21, "день"], [22, "дня"], [25, "дней"], [101, "день"], [111, "дней"]].forEach(([n, word]) => {
  const s = st({ quests: [daily("a", false)], streak: n, lastCompletionDate: YESTERDAY });
  const d = r.decideReminder(s, TODAY);
  const got = d && d.text.includes(n + " " + word + " подряд");
  check(n + " → «" + word + "»", got, true);
});

console.log("\n— мусор на входе не роняет крон —");
check("нет state", r.decideReminder(null, TODAY), null);
check("state без quests", r.decideReminder({}, TODAY), null);
check("quests не массив", r.decideReminder({ quests: "нет" }, TODAY), null);

console.log("\n— окно отправки —");
check("окно задано как 19–23", [r.SEND_HOUR_FROM, r.SEND_HOUR_TO], [19, 23]);
check("mskDateStr отдаёт YYYY-MM-DD", /^\d{4}-\d{2}-\d{2}$/.test(r.mskDateStr()), true);
const h = r.mskHour();
check("mskHour в диапазоне 0..23", h >= 0 && h <= 23, true);
check("isWithinSendWindow согласован с mskHour", r.isWithinSendWindow(), h >= 19 && h < 23);

console.log("\n— текст сообщения —");
const one = r.decideReminder(st({ quests: [daily("a", true), daily("b", false)] }), TODAY);
check("при одном незакрытом называем его", one.text.includes("Задание b"), true);
const many = r.decideReminder(st({ quests: [daily("a", false), daily("b", false), daily("c", false)] }), TODAY);
check("при нескольких — считаем их", many.text.includes("заданий: 3"), true);
check("лор Долгого Штиля есть в обоих типах",
  [one.text.includes("Долгий Штиль"), r.decideReminder(st({ quests: [daily("a", false)], streak: 5, lastCompletionDate: YESTERDAY }), TODAY).text.includes("Долгий Штиль")],
  [true, true]);

console.log(failures ? "\n" + failures + " провалов\n" : "\nвсе проверки напоминаний прошли\n");
process.exit(failures ? 1 : 0);
