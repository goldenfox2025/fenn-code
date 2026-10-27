import { expect, it } from 'vitest';
import { distanceFromBottom, isAtBottom } from '../src/shared/scrollPosition';
it('hides bottom affordances when all content fits, including resize and fractional positions', () => {
  expect(isAtBottom({ scrollHeight: 400, clientHeight: 700, scrollTop: 0 })).toBe(true);
  expect(isAtBottom({ scrollHeight: 700, clientHeight: 700, scrollTop: 0 })).toBe(true);
  expect(isAtBottom({ scrollHeight: 1200, clientHeight: 700, scrollTop: 499.3 })).toBe(true);
  expect(isAtBottom({ scrollHeight: 1200, clientHeight: 700, scrollTop: 300 })).toBe(false);
  expect(distanceFromBottom({ scrollHeight: 1200, clientHeight: 700, scrollTop: 510 })).toBe(0);
});
