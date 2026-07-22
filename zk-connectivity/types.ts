export interface RelType {
  name: string;
  desc: string;
}

// Системный тип: завязан в логику MOC (isMoc, участники, авто-подстановка).
// Его нельзя удалить/переименовать; он всегда присутствует.
export const MOC_TYPE = "moc";
const MOC_DESC = "эта входит в карту (MOC) — членство";

export function isSystemType(name: string): boolean {
  return name === MOC_TYPE;
}

// Читается как «эта заметка [тип] цель»
export const DEFAULT_REL_TYPES: RelType[] = [
  { name: "развивает", desc: "эта заметка развивает цель — строится на ней, углубляет" },
  { name: "уточняет", desc: "эта уточняет цель — частный случай, механизм" },
  { name: "противоречит", desc: "эта спорит с целью (взаимно)" },
  { name: "пример", desc: "эта — пример/иллюстрация цели" },
  { name: "контекст", desc: "цель — источник/фон этой мысли" },
  { name: MOC_TYPE, desc: MOC_DESC },
  { name: "related", desc: "просто связано, без направления" },
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
  // moc — системный тип, гарантируем его присутствие
  if (!out.some((t) => t.name === MOC_TYPE)) out.push({ name: MOC_TYPE, desc: MOC_DESC });
  return out.length ? out : DEFAULT_REL_TYPES.map((t) => ({ ...t }));
}
