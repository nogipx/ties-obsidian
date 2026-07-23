export interface RelType {
  name: string;
  desc: string;
}

// Системные типы: всегда присутствуют, нельзя удалить/переименовать.
//   moc     — членство в карте (авто-тип: скрыт из пикера, без смены типа);
//   related — дефолтная цель при удалении/слиянии типов (обычный выбираемый тип).
export const MOC_TYPE = "moc";
export const RELATED_TYPE = "related";
const MOC_DESC = "эта входит в карту (MOC) — членство";
const RELATED_DESC = "просто связано, без направления";

export function isSystemType(name: string): boolean {
  return name === MOC_TYPE || name === RELATED_TYPE;
}

// Читается как «эта заметка [тип] цель»
export const DEFAULT_REL_TYPES: RelType[] = [
  { name: "развивает", desc: "эта заметка развивает цель — строится на ней, углубляет" },
  { name: "уточняет", desc: "эта уточняет цель — частный случай, механизм" },
  { name: "противоречит", desc: "эта спорит с целью (взаимно)" },
  { name: "пример", desc: "эта — пример/иллюстрация цели" },
  { name: "контекст", desc: "цель — источник/фон этой мысли" },
  { name: MOC_TYPE, desc: MOC_DESC },
  { name: RELATED_TYPE, desc: RELATED_DESC },
];

export function normalizeTypes(v: unknown): RelType[] {
  if (!Array.isArray(v) || v.length === 0) return DEFAULT_REL_TYPES.map((t) => ({ ...t }));
  const known = new Map(DEFAULT_REL_TYPES.map((t) => [t.name, t.desc]));
  const out: RelType[] = [];
  for (const item of v) {
    if (typeof item === "string") {
      const name = item.trim();
      if (name) out.push({ name, desc: known.get(name) ?? "" });
    } else if (item && typeof item === "object" && typeof (item as any).name === "string") {
      const name = (item as any).name.trim();
      if (name) out.push({ name, desc: String((item as any).desc ?? known.get(name) ?? "") });
    }
  }
  // Системные типы гарантируем всегда
  if (!out.some((t) => t.name === MOC_TYPE)) out.push({ name: MOC_TYPE, desc: MOC_DESC });
  if (!out.some((t) => t.name === RELATED_TYPE)) out.push({ name: RELATED_TYPE, desc: RELATED_DESC });
  return out.length ? out : DEFAULT_REL_TYPES.map((t) => ({ ...t }));
}
