// 2026 national holiday schedule used in Chengdu. Source: State Council,
// https://www.gov.cn/zhengce/zhengceku/202511/content_7047091.htm
// Update this calendar when the next official annual schedule is published.
const holidays = [
  ['2026-01-01', '2026-01-03'], ['2026-02-15', '2026-02-23'],
  ['2026-04-04', '2026-04-06'], ['2026-05-01', '2026-05-05'],
  ['2026-06-19', '2026-06-21'], ['2026-09-25', '2026-09-27'],
  ['2026-10-01', '2026-10-07']
];
const workingWeekends = new Set(['2026-01-04', '2026-02-14', '2026-02-28', '2026-05-09', '2026-09-20', '2026-10-10']);

export function reviewWindow(now = Date.now()) {
  const local = new Date(now + 8 * 60 * 60 * 1000);
  const date = local.toISOString().slice(0, 10);
  const calendarKnown = local.getUTCFullYear() === 2026;
  const weekend = [0, 6].includes(local.getUTCDay());
  const restDay = calendarKnown && !workingWeekends.has(date) &&
    (weekend || holidays.some(([start, end]) => date >= start && date <= end));
  const minute = local.getUTCHours() * 60 + local.getUTCMinutes();
  const evening = minute >= 20 * 60 + 30 && minute <= 22 * 60 + 20;
  const open = restDay || evening;
  const kind = !calendarKnown ? 'calendar_unknown' : restDay ? 'rest_day' : 'workday';
  let message = restDay ? '今日为休息日，全天可审核工单。' :
    '今日为工作日，审核时间为北京时间 20:30–22:20。';
  if (!calendarKnown) message = '本年度调休日历尚未更新，暂仅在北京时间 20:30–22:20 开放审核。';
  if (!open) message += ' 当前不在审核时段，玩家仍可提交工单。';
  return { open, calendarKnown, date, kind, message, timeZone: 'Asia/Shanghai' };
}
