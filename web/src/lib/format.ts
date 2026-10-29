export function clock(seconds: number): string {
  const s = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

export function plural(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

export function excerpts(n: number): string {
  return `${n} ${plural(n, 'отрывок', 'отрывка', 'отрывков')}`;
}

export function times(n: number): string {
  return `${n} ${plural(n, 'раз', 'раза', 'раз')}`;
}

export function seconds(n: number): string {
  return `${n} ${plural(n, 'секунда', 'секунды', 'секунд')}`;
}

export function searchKey(s: string): string {
  return s
    .toLocaleLowerCase('ru')
    .replace(/ё/g, 'е')
    .replace(/ß/g, 'ss')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
