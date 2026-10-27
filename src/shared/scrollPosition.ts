type ScrollArea = Pick<HTMLElement, 'scrollHeight' | 'scrollTop' | 'clientHeight'>;
export function distanceFromBottom(area: ScrollArea): number {
  return Math.max(0, area.scrollHeight - area.scrollTop - area.clientHeight);
}
export function isAtBottom(area: ScrollArea, tolerance = 12): boolean {
  return distanceFromBottom(area) <= tolerance;
}
