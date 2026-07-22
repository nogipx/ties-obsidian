import { App, TFile } from "obsidian";
import { computeConnections } from "./connectionsView";
import { isMoc, directMembers, orbit, pathToMoc } from "./moc";
import { removeLink } from "./linkStore";
import { confirm } from "./confirmModal";
import { promptText } from "./promptModal";
import { getMemberWhy, setMemberWhy } from "./memberWhy";
import { isSystemType } from "./types";

export interface BodyOpts {
  includeBody: boolean;
  mocPattern: string;
  editable: boolean; // показывать × для удаления
  onChange: () => void; // вызвать после удаления (перерисовать)
  openLink: (path: string) => void;
  changeType?: (fromType: string, target: TFile) => Promise<void>; // сменить тип исходящей связи
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
  } else {
    const path = pathToMoc(app, file, opts.mocPattern);
    if (path && path.length > 1) {
      const line = el.createDiv({ cls: "zk-footer-nearest" });
      line.appendText("↑ ближайший MOC: ");
      linkEl(line, path[path.length - 1], opts);
    } else if (outgoing.size === 0 && incoming.size === 0) {
      el.createDiv({ text: "Связей пока нет.", cls: "zk-empty" });
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
      if (editable && opts.changeType && !isSystemType(type)) {
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
