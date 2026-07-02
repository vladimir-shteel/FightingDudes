let nextId = 1;

export function generateId(prefix) {
  return `${prefix}-${nextId++}`;
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function formatNumber(value) {
  return Math.floor(value).toLocaleString("en-US");
}

export function sum(array, getter) {
  return array.reduce((accumulator, item) => accumulator + getter(item), 0);
}
