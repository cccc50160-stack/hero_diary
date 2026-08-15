/* Пуш-напоминания через бота.

   Почему внешний крон, а не setInterval внутри процесса: на бесплатном тарифе Render
   инстанс засыпает без входящих запросов, и таймер внутри него просто не проснётся.
   Поэтому решение снаружи: любой бесплатный пингер (cron-job.org и т.п.) раз в час дёргает
   GET /api/cron/reminders?key=<CRON_SECRET>, а вся логика «кому и что слать» живёт здесь.

   Два типа сообщений, приоритет — у первого:
     1) стрик под угрозой — сегодня ещё ничего не закрыто, а серия живая;
     2) обычное вечернее напоминание про незакрытые дневные задания.
   Больше одного пуша в сутки одному человеку не уходит (см. last_reminder_date в БД). */

const TELEGRAM_API = "https://api.telegram.org";

// Окно отправки по Москве. Раньше — человек ещё в дне и напоминать не о чем, позже — уже
// поздно что-то успевать, и пуш работает как упрёк, а не как подсказка.
const SEND_HOUR_FROM = 19;
const SEND_HOUR_TO = 23; // не включительно

function mskNow() {
  const now = new Date();
  return new Date(now.getTime() + 3 * 3600000); // МСК = UTC+3 круглый год, без перехода на летнее
}

function mskDateStr(d) {
  const x = d || mskNow();
  return (
    x.getUTCFullYear() +
    "-" +
    String(x.getUTCMonth() + 1).padStart(2, "0") +
    "-" +
    String(x.getUTCDate()).padStart(2, "0")
  );
}

function mskHour() {
  return mskNow().getUTCHours();
}

function shiftDays(dateStr, days) {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return mskDateStr(d);
}

function isWithinSendWindow() {
  const h = mskHour();
  return h >= SEND_HOUR_FROM && h < SEND_HOUR_TO;
}

// Повтор клиентской isQuestLocked(): задание с `requires` не считается «незакрытым»,
// пока не выполнено то, от которого оно зависит — напоминать про него бессмысленно.
function isSatisfied(q) {
  if (!q) return true;
  if (q.type === "counter") return q.progress >= q.target;
  if (q.type === "boss") return q.hp <= 0;
  return !!q.done;
}

function isLocked(quests, q) {
  if (!q || !q.requires) return false;
  const req = quests.filter((x) => x.id === q.requires)[0];
  return !isSatisfied(req);
}

/* Что именно (если вообще) слать этому человеку прямо сейчас.
   Возвращает { type, text } либо null. */
function decideReminder(state, today) {
  if (!state || !Array.isArray(state.quests)) return null;

  const yesterday = shiftDays(today, -1);
  const quests = state.quests;
  const dailies = quests.filter((q) => q.type === "daily" && !isLocked(quests, q));
  if (!dailies.length) return null;

  // Ключевой момент: сброс дневных заданий происходит на клиенте, при открытии мини-аппа.
  // Значит у того, кто сегодня не заходил, в базе лежат вчерашние галочки `done:true` —
  // и считать их выполненными сегодня нельзя. Для такого человека незакрыто ВСЁ.
  const openedToday = state.lastActiveDate === today;
  const undone = openedToday ? dailies.filter((q) => !q.done) : dailies;
  if (!undone.length) return null;

  const streak = Number(state.streak) || 0;
  const closedToday = state.lastCompletionDate === today;
  if (closedToday) return null; // день уже засчитан, дёргать не за чем

  // Стрик «живой и под угрозой» — только если последняя закрытая серия была именно вчера.
  // Если раньше — серия уже оборвалась сама, и пугать ею нечестно.
  if (streak >= 2 && state.lastCompletionDate === yesterday) {
    return {
      type: "streak",
      text:
        "🔥 " + streak + " " + dayWord(streak) + " подряд ты не сходил с тропы.\n\n" +
        "Сегодня костёр ещё не разожжён — а до полуночи осталось немного. " +
        "Хватит одного закрытого задания, чтобы серия осталась цела.\n\n" +
        "🌫️ Долгий Штиль как раз и ждёт вечеров, когда проще не начинать."
    };
  }

  const n = undone.length;
  return {
    type: "daily",
    text:
      "🤠 Вечер на фронтире. Незакрытых дневных заданий: " + n + ".\n\n" +
      (n === 1
        ? "Осталось одно — «" + String(undone[0].title || "").slice(0, 60) + "»."
        : "Не обязательно все — тропа считает любой пройденный шаг.") +
      "\n\n🌫️ Долгий Штиль не нападает. Он просто стоит и ждёт, пока ты остановишься."
  };
}

function dayWord(n) {
  const mod100 = n % 100;
  const mod10 = n % 10;
  if (mod100 >= 11 && mod100 <= 14) return "дней";
  if (mod10 === 1) return "день";
  if (mod10 >= 2 && mod10 <= 4) return "дня";
  return "дней";
}

/* Отправка. Возвращает { ok } либо { ok:false, blocked } — blocked означает, что писать
   этому человеку нельзя в принципе (заблокировал бота / не нажимал /start), и повторять
   попытку каждый вечер бессмысленно: такой случай мы всё равно отмечаем как «обработан». */
async function sendTelegramMessage(botToken, chatId, text) {
  try {
    const res = await fetch(TELEGRAM_API + "/bot" + botToken + "/sendMessage", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        disable_notification: false,
        reply_markup: {
          inline_keyboard: [[{ text: "Открыть дневник", url: process.env.MINIAPP_URL || "https://t.me/herodiary_bot" }]]
        }
      })
    });
    if (res.ok) return { ok: true };
    const body = await res.json().catch(() => ({}));
    const code = body && body.error_code;
    const blocked = code === 403 || code === 400;
    return { ok: false, blocked, description: (body && body.description) || ("http_" + res.status) };
  } catch (err) {
    return { ok: false, blocked: false, description: String(err && err.message) };
  }
}

module.exports = {
  mskDateStr,
  mskHour,
  isWithinSendWindow,
  decideReminder,
  sendTelegramMessage,
  SEND_HOUR_FROM,
  SEND_HOUR_TO
};
