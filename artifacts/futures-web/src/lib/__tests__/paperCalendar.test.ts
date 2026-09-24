import {describe,it,expect} from 'vitest';
import {calendarMonthCells,shiftCalendarMonth} from '../paperCalendar';
describe('calendar month boundaries',()=>{
 it.each([['2024-02',29],['2026-02',28],['2026-04',30],['2026-12',31]])('renders every day of %s', (month,count)=>{
  const cells=calendarMonthCells(month as string);expect(cells.filter(Boolean)).toHaveLength(count as number);
  expect(cells.filter(Boolean)[0]).toBe(`${month}-01`);expect(cells.filter(Boolean).at(-1)).toBe(`${month}-${count}`);
  expect(cells.length%7).toBe(0);
 });
 it('handles year rollover and invalid months',()=>{expect(shiftCalendarMonth('2026-12',1)).toBe('2027-01');expect(shiftCalendarMonth('2026-01',-1)).toBe('2025-12');expect(calendarMonthCells('2026-13')).toEqual([]);});
});
