import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewWindow } from '../lib/review-calendar.mjs';
const at = time => reviewWindow(Date.parse(time + '+08:00'));

test('review window uses Beijing time and includes the entire 22:20 minute', () => {
  assert.equal(at('2026-10-08T20:29:59').open, false);
  assert.equal(at('2026-10-08T20:30:00').open, true);
  assert.equal(at('2026-10-08T22:20:59').open, true);
  assert.equal(at('2026-10-08T22:21:00').open, false);
});

test('2026 holidays override weekdays and makeup work overrides weekends', () => {
  for (const date of ['01-01','02-23','04-06','05-05','06-19','09-25','10-01','10-07','10-11']) {
    assert.equal(at(`2026-${date}T09:00:00`).open, true, date);
  }
  for (const date of ['01-04','02-14','02-28','05-09','09-20','10-10']) {
    assert.equal(at(`2026-${date}T09:00:00`).open, false, date);
    assert.equal(at(`2026-${date}T21:00:00`).open, true, date);
  }
});

test('unknown annual calendar never incorrectly grants all-day review', () => {
  const future = at('2027-01-03T09:00:00');
  assert.equal(future.calendarKnown, false);
  assert.equal(future.open, false);
  assert.match(future.message, /尚未更新/);
  assert.equal(at('2027-01-03T21:00:00').open, true);
});
