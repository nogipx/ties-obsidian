import { App, TFile } from "obsidian";
import { computeConnections } from "./connectionsView";
import { isMoc, directMembers, orbit, reachableMocs } from "./moc";
import { MocsModal } from "./graphModals";
import { removeLink } from "./linkStore";
import { confirm } from "./confirmModal";
import { promptText } from "./promptModal";
import { getMemberWhy, setMemberWhy } from "./memberWhy";
import { MOC_TYPE } from "./types";

export interface BodyOpts {
  includeBody: boolean;
  mocPattern: string;
  editable: boolean; // показывать × для удаления
  onChange: () => void; // вызвать после удаления (перерисовать)
  openLink: (path: string) => void;
  changeType?: (fromType: string, target: TFile) => Promise<void>; // сменить тип исходящей связи
  onTypes?: () => void; // открыть справку по типам (иконка на строке первой секции)
}

export interface MocButtonOpts {
  blockStyle?: boolean;
  // Переупорядочить достижимые MOC по семантической близости к заметке (лучший — первый).
  // Если недоступно (нет эмбеддингов) — вернуть как есть (порядок по хопам).
  rankMocs?: (from: TFile, mocs: TFile[]) => TFile[];
}

// Кнопки MOC в хедере: основная — сразу переход к семантически подходящему MOC;
// вторая (если карт >1) — меню соседних MOC по близости (хопам).
export function renderMocButton(
  app: App,
  parent: HTMLElement,
  file: TFile,
  pattern: string,
  onNavigate: (path: string) => void,
  opts: MocButtonOpts = {}
): void {
  const reachable = reachableMocs(app, file, pattern);
  if (reachable.length === 0) return;

  const rankedFiles = opts.rankMocs
    ? opts.rankMocs(file, reachable.map((m) => m.file))
    : reachable.map((m) => m.file);
  const best = rankedFiles[0];
  const tag = opts.blockStyle ? "a" : "button";

  const btn = parent.createEl(tag, {
    text: `↑ ${best.basename}`,
    cls: opts.blockStyle ? "zk-block-moc" : "zk-moc-btn",
  });
  btn.setAttribute("aria-label", "подходящий MOC");
  btn.addEventListener("click", (e) => {
    e.preventDefault();
    onNavigate(best.path);
  });

  if (reachable.length > 1) {
    const more = parent.createEl(tag, {
      text: `карты (${reachable.length})`,
      cls: opts.blockStyle ? "zk-block-moc-more" : "zk-moc-more",
    });
    more.setAttribute("aria-label", "соседние MOC с путями");
    more.addEventListener("click", (e) => {
      e.preventDefault();
      new MocsModal(app, reachable, onNavigate).open();
    });
  }
}

// Рендер тела связей заметки: сам определяет MOC vs обычная и рисует соответственно.
// Общий код для модалки и блока ```ties```.
export function renderConnectionsBody(
  app: App,
  el: HTMLElement,
  file: TFile,
  opts: BodyOpts
): void {
  el.empty();
  const isMocFile = isMoc(app, file, opts.mocPattern);
  const { outgoing, incoming } = computeConnections(app, file, opts.includeBody);

  typedSection(app, el, "Исходящие", outgoing, file, opts.editable, opts);
  // Для MOC участников показываем отдельным блоком — не дублируем во «Входящих»
  if (isMocFile) incoming.delete("moc");
  typedSection(app, el, "Входящие", incoming, file, false, opts);

  if (isMocFile) {
    const members = directMembers(app, file);
    const orb = orbit(app, file, members, opts.mocPattern);
    membersSection(app, el, file, members, opts);
    plainSection(
      el,
      `Орбита (${orb.length})`,
      orb.map((o) => ({ file: o.file, note: `×${o.count}` })),
      opts
    );
  } else if (outgoing.size === 0 && incoming.size === 0) {
    el.createDiv({ text: "Связей пока нет.", cls: "zk-empty" });
  }

  // Иконка «типы» — справа на строке первой секции (вместо кнопки в хедере)
  if (opts.onTypes) {
    const title = el.querySelector<HTMLElement>(".zk-section-title");
    if (title) {
      const info = title.createEl("a", { text: "ⓘ типы", cls: "zk-types-icon" });
      info.setAttribute("aria-label", "типы связей");
      info.addEventListener("click", (e) => {
        e.preventDefault();
        opts.onTypes!();
      });
    }
  }
}

function typedSection(
  app: App,
  parent: HTMLElement,
  title: string,
  groups: Map<string, TFile[]>,
  file: TFile,
  editable: boolean,
  opts: BodyOpts
): void {
  if (groups.size === 0) return;
  const wrap = parent.createDiv({ cls: "zk-section" });
  wrap.createDiv({ text: title, cls: "zk-section-title" });
  for (const [type, files] of groups) {
    const g = wrap.createDiv({ cls: "zk-group" });
    g.createDiv({ text: type, cls: "zk-type" });
    for (const f of files) {
      const row = g.createDiv({ cls: "zk-row" });
      linkEl(row, f, opts);
      if (editable && opts.changeType && type !== MOC_TYPE) {
        const ch = row.createEl("a", { text: "⇄", cls: "zk-change" });
        ch.setAttribute("aria-label", "сменить тип связи");
        ch.addEventListener("click", async (e) => {
          e.preventDefault();
          e.stopPropagation();
          await opts.changeType!(type, f);
          opts.onChange();
        });
      }
      if (editable) {
        const x = row.createEl("a", { text: "×", cls: "zk-remove" });
        x.setAttribute("aria-label", "убрать связь");
        x.addEventListener("click", async (e) => {
          e.preventDefault();
          e.stopPropagation();
          const ok = await confirm(app, {
            title: "Убрать связь?",
            message: `${type} → ${f.basename}`,
            cta: "Убрать",
            danger: true,
          });
          if (!ok) return;
          await removeLink(app, file, type, f);
          opts.onChange();
        });
      }
    }
  }
}

function plainSection(
  parent: HTMLElement,
  title: string,
  items: Array<{ file: TFile; note?: string }>,
  opts: BodyOpts
): void {
  const wrap = parent.createDiv({ cls: "zk-section" });
  wrap.createDiv({ text: title, cls: "zk-section-title" });
  if (items.length === 0) {
    wrap.createDiv({ text: "—", cls: "zk-empty" });
    return;
  }
  for (const it of items) {
    const row = wrap.createDiv({ cls: "zk-row" });
    linkEl(row, it.file, opts);
    if (it.note) row.createSpan({ text: " " + it.note, cls: "zk-count" });
  }
}

// Участники MOC: имя + пояснение «почему в карте» (алиас moc-ссылки) + ✎ для правки
function membersSection(
  app: App,
  parent: HTMLElement,
  moc: TFile,
  members: TFile[],
  opts: BodyOpts
): void {
  const wrap = parent.createDiv({ cls: "zk-section" });
  wrap.createDiv({ text: `Участники (${members.length})`, cls: "zk-section-title" });
  if (members.length === 0) {
    wrap.createDiv({ text: "—", cls: "zk-empty" });
    return;
  }
  for (const m of members) {
    const why = getMemberWhy(app, moc, m);
    const item = wrap.createDiv({ cls: "zk-member" });
    const row = item.createDiv({ cls: "zk-row" });
    linkEl(row, m, opts);
    if (opts.editable) {
      const edit = row.createEl("a", {
        text: why ? "✎" : "＋почему",
        cls: "zk-member-edit",
      });
      edit.setAttribute("aria-label", "пояснение: почему в карте");
      edit.addEventListener("click", async (e) => {
        e.preventDefault();
        e.stopPropagation();
        const val = await promptText(app, {
          title: `Почему «${m.basename}» в карте?`,
          value: why,
          placeholder: "короткое пояснение (пусто — убрать)",
          cta: "Сохранить",
        });
        if (val === null) return;
        await setMemberWhy(app, moc, m, val);
        opts.onChange();
      });
    }
    if (why) item.createDiv({ text: why, cls: "zk-member-why" });
  }
}

function linkEl(parent: HTMLElement, f: TFile, opts: BodyOpts): void {
  const a = parent.createEl("a", { text: f.basename, cls: "zk-link" });
  a.addEventListener("click", (e) => {
    e.preventDefault();
    opts.openLink(f.path);
  });
}
