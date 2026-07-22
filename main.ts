import {
  App,
  debounce,
  MarkdownView,
  moment,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  setIcon,
  TFile,
  WorkspaceLeaf,
} from "obsidian";
import { addLink, removeLink } from "./linkStore";
import { pickSimilar, pickType, ScoredFile } from "./pickers";
import { promptText } from "./promptModal";
import { DEFAULT_REL_TYPES, isSystemType, normalizeTypes, RelType } from "./types";
import { TypesModal } from "./typesModal";
import { embed, stripFrontmatter } from "./embeddings";
import { EmbeddingIndex, mkdirp } from "./embIndex";
import { computeConnections, ConnectionsView, VIEW_TYPE_TIES } from "./connectionsView";
import { ConnectionsModal } from "./connectionsModal";
import { TiesBlock } from "./tiesBlock";
import { isMoc, pathToMoc } from "./moc";
import { buildGraph, kShortestPaths, personalizedPageRank, buildTree } from "./graph";
import { PathsModal, NeighborhoodModal, TreeModal } from "./graphModals";
import { HelpModal } from "./helpModal";

// Исходник индексера, вшитый esbuild (см. esbuild.config.mjs -> define).
declare const __INDEXER_SOURCE__: string;

interface TiesSettings {
  relationTypes: RelType[];
  includeBodyLinks: boolean;
  showButton: boolean;
  mocPattern: string;
  stampCreated: boolean;
  createdProperty: string;
  createdFormat: string;
  autoEmbed: boolean;
  embeddingsPath: string;
  readOnlyEmbeddings: boolean;
  ollamaUrl: string;
  ollamaModel: string;
}

const DEFAULT_SETTINGS: TiesSettings = {
  relationTypes: DEFAULT_REL_TYPES,
  includeBodyLinks: false,
  showButton: true,
  mocPattern: "MOC *",
  stampCreated: true,
  createdProperty: "created",
  createdFormat: "YYYY-MM-DDTHH:mm",
  autoEmbed: true,
  embeddingsPath: "",
  readOnlyEmbeddings: false,
  ollamaUrl: "http://127.0.0.1:11434",
  ollamaModel: "bge-m3",
};

// Объединить значения frontmatter (строка|список) в список уникальных строк.
function mergeUnique(a: unknown, b: unknown): string[] {
  const toList = (v: unknown): string[] =>
    v == null ? [] : (Array.isArray(v) ? v : [v]).map((x) => String(x));
  return [...new Set([...toList(a), ...toList(b)])];
}

export default class TiesPlugin extends Plugin {
  settings: TiesSettings;
  embIndex: EmbeddingIndex;
  private actionViews = new WeakSet<MarkdownView>();
  private actionEls: HTMLElement[] = [];
  private reembedQueue = new Set<string>();
  lastType = "";

  async onload() {
    await this.loadSettings();

    this.embIndex = new EmbeddingIndex(
      this.app,
      this.embeddingsCachePath(),
      () => ({ url: this.settings.ollamaUrl, model: this.settings.ollamaModel }),
      () => this.settings.readOnlyEmbeddings
    );
    this.app.workspace.onLayoutReady(() => this.embIndex.load());
    this.registerEvent(
      this.app.vault.on("delete", (file) => {
        if (file instanceof TFile) this.embIndex.remove(file.path);
      })
    );
    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        if (file instanceof TFile) this.embIndex.remove(oldPath);
      })
    );
    // Авто-обновление эмбеддинга изменённой заметки (debounced), чтобы «похожие»
    // были свежими без ручной переиндексации.
    const reembed = debounce(() => void this.flushReembed(), 2500, false);
    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        if (!this.settings.autoEmbed || this.settings.readOnlyEmbeddings) return;
        if (file instanceof TFile && file.extension === "md") {
          this.reembedQueue.add(file.path);
          reembed();
        }
      })
    );

    // Боковая панель (опционально)
    this.registerView(
      VIEW_TYPE_TIES,
      (leaf) => new ConnectionsView(leaf, () => this.settings.includeBodyLinks)
    );

    // Кнопка в шапке заметки (нативный view action) — открывает модалку связей
    const syncActions = debounce(() => this.refreshActions(), 60, true);
    this.registerEvent(this.app.workspace.on("layout-change", syncActions));
    this.registerEvent(this.app.workspace.on("active-leaf-change", syncActions));
    this.registerEvent(this.app.workspace.on("file-open", syncActions));
    this.app.workspace.onLayoutReady(() => this.refreshActions());

    // Штамп created при создании заметки (без шаблонов). Вешаем ПОСЛЕ onLayoutReady,
    // иначе Obsidian при старте шлёт «create» на все существующие файлы и они бы
    // проштамповались заново.
    this.app.workspace.onLayoutReady(() => {
      this.registerEvent(
        this.app.vault.on("create", (f) => {
          if (f instanceof TFile && f.extension === "md") void this.stampCreated(f);
        })
      );
    });

    // Блок ```ties``` — рендер связей прямо в теле заметки
    this.registerMarkdownCodeBlockProcessor("ties", (_src, el, ctx) => {
      const f = this.app.vault.getAbstractFileByPath(ctx.sourcePath);
      if (!(f instanceof TFile)) {
        el.createDiv({ text: "Ties: файл не найден", cls: "zk-empty" });
        return;
      }
      ctx.addChild(
        new TiesBlock(
          this.app,
          f,
          {
            includeBody: () => this.settings.includeBodyLinks,
            mocPattern: () => this.settings.mocPattern,
            types: () => this.settings.relationTypes,
            connect: () => this.connectFromActive(),
            changeType: (fromType, target) => this.changeLinkType(f, fromType, target),
          },
          el
        )
      );
    });

    this.addRibbonIcon("link", "Ties: связать заметку", () => this.connectFromActive());

    this.addCommand({
      id: "connect-note",
      name: "Связать заметку",
      callback: () => this.connectFromActive(),
    });

    this.addCommand({
      id: "open-connections-modal",
      name: "Показать связи заметки",
      hotkeys: [{ modifiers: ["Mod", "Shift"], key: "l" }],
      callback: () => this.openConnectionsModal(),
    });

    this.addCommand({
      id: "open-connections",
      name: "Открыть боковую панель связей",
      callback: () => this.activateView(),
    });

    this.addCommand({
      id: "path-to-moc",
      name: "Показать путь до ближайшего MOC",
      callback: () => {
        const f = this.app.workspace.getActiveFile();
        if (!f) {
          new Notice("Нет активной заметки");
          return;
        }
        const path = pathToMoc(this.app, f, this.settings.mocPattern);
        if (!path) {
          new Notice("Нет пути до MOC — заметка-сирота");
          return;
        }
        if (path.length === 1) {
          new Notice("Это сам MOC");
          return;
        }
        new Notice(path.map((x) => x.basename).join(" → "), 8000);
      },
    });

    this.addCommand({
      id: "reindex-embeddings",
      name: "Переиндексировать похожие (эмбеддинги)",
      callback: async () => {
        if (this.settings.readOnlyEmbeddings) {
          new Notice("Кэш эмбеддингов только для чтения — индексирует сервер");
          return;
        }
        const files = this.app.vault.getMarkdownFiles();
        const notice = new Notice(`Индексирую эмбеддинги… 0/${files.length}`, 0);
        try {
          await this.embIndex.build(files, (done, total) => {
            notice.setMessage(`Индексирую эмбеддинги… ${done}/${total}`);
          });
          notice.setMessage(`Эмбеддинги готовы ✓ (${this.embIndex.size()})`);
        } catch (e) {
          console.error("[ties] reindex error", e);
          notice.setMessage(`Ошибка индексации: ${e instanceof Error ? e.message : String(e)}`);
        }
        setTimeout(() => notice.hide(), 3000);
      },
    });

    this.addCommand({
      id: "check-ollama",
      name: "Проверить Ollama",
      callback: async () => {
        const f = this.app.workspace.getActiveFile();
        if (!f) {
          new Notice("Нет активной заметки");
          return;
        }
        new Notice("Считаю эмбеддинг через Ollama…");
        try {
          const text = stripFrontmatter(await this.app.vault.cachedRead(f)).slice(0, 2000);
          const t0 = performance.now();
          const v = await embed(text, {
            url: this.settings.ollamaUrl,
            model: this.settings.ollamaModel,
          });
          const dt = Math.round(performance.now() - t0);
          console.log("[ties] ollama embed dim", v.length, dt + "ms");
          new Notice(`Ollama ок: dim=${v.length}, ${dt}ms`);
        } catch (e) {
          console.error("[ties] ollama error", e);
          new Notice(
            `Ollama ошибка: ${e instanceof Error ? e.message : String(e)}. Запущен ли Ollama и есть ли модель «${this.settings.ollamaModel}»?`
          );
        }
      },
    });

    this.addCommand({
      id: "graph-paths",
      name: "Пути между заметками",
      callback: async () => {
        const from = this.app.workspace.getActiveFile();
        if (!from) {
          new Notice("Нет активной заметки");
          return;
        }
        const scored = await this.rankedCandidates(from);
        const to = await pickSimilar(this.app, scored, "Куда искать путь · похожие сверху");
        if (!to) return;
        const graph = buildGraph(this.app, this.settings.includeBodyLinks);
        const compute = (a: TFile, b: TFile) => kShortestPaths(graph, a.path, b.path, 5);
        new PathsModal(this.app, from, graph, to, compute(from, to), {
          compute,
          pick: async (relativeTo, placeholder) =>
            pickSimilar(this.app, await this.rankedCandidates(relativeTo), placeholder),
          neighborhood: (seed) => {
            const rank = personalizedPageRank(graph, seed.path);
            const items = [...rank.entries()]
              .filter(([p, s]) => p !== seed.path && s > 0)
              .sort((a, b) => b[1] - a[1])
              .slice(0, 25)
              .map(([p, s]) => ({ path: p, score: s }));
            new NeighborhoodModal(this.app, seed, items).open();
          },
        }).open();
      },
    });

    this.addCommand({
      id: "graph-tree",
      name: "Все пути из заметки (обход)",
      callback: () => {
        const from = this.app.workspace.getActiveFile();
        if (!from) {
          new Notice("Нет активной заметки");
          return;
        }
        const graph = buildGraph(this.app, this.settings.includeBodyLinks);
        new TreeModal(this.app, from, {
          build: (und) => buildTree(graph, from.path, und),
        }).open();
      },
    });

    this.addCommand({
      id: "graph-neighborhood",
      name: "Окрестность заметки (PageRank)",
      callback: () => {
        const seed = this.app.workspace.getActiveFile();
        if (!seed) {
          new Notice("Нет активной заметки");
          return;
        }
        const graph = buildGraph(this.app, this.settings.includeBodyLinks);
        const rank = personalizedPageRank(graph, seed.path);
        const items = [...rank.entries()]
          .filter(([p, s]) => p !== seed.path && s > 0)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 25)
          .map(([p, s]) => ({ path: p, score: s }));
        new NeighborhoodModal(this.app, seed, items).open();
      },
    });

    this.addCommand({
      id: "help",
      name: "Справка",
      callback: () => new HelpModal(this.app).open(),
    });

    this.addSettingTab(new TiesSettingTab(this.app, this));
    console.log("[ties] loaded");
  }

  onunload() {
    void this.embIndex.save();
    this.removeActions();
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_TIES);
    console.log("[ties] unloaded");
  }

  async activateView(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_TIES);
    let leaf: WorkspaceLeaf | null = existing[0] ?? null;
    if (!leaf) {
      leaf = this.app.workspace.getRightLeaf(false);
      if (!leaf) return;
      await leaf.setViewState({ type: VIEW_TYPE_TIES, active: true });
    }
    this.app.workspace.revealLeaf(leaf);
  }

  embeddingsCacheDir(): string {
    const dir = this.settings.embeddingsPath?.trim();
    if (!dir) return this.manifest.dir ?? "";
    return dir.replace(/^\.\//, "").replace(/\/+$/, ""); // убрать ./ и хвостовой /
  }

  embeddingsCachePath(): string {
    return `${this.embeddingsCacheDir()}/ties-embeddings.bin`;
  }

  // Разложить standalone-индексер (вшитый в плагин) в папку кэша — оттуда rhyolite
  // синхронизирует его на сервер, где достаточно `node ties-indexer.mjs --watch`.
  async deployIndexer(): Promise<void> {
    const dir = this.embeddingsCacheDir();
    const target = `${dir}/ties-indexer.mjs`;
    try {
      if (dir) await mkdirp(this.app, dir);
      await this.app.vault.adapter.write(target, __INDEXER_SOURCE__);
      new Notice(`Индексер разложен: ${target}`);
    } catch (e) {
      new Notice(`Не удалось разложить индексер: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  openConnectionsModal(file: TFile | null = this.app.workspace.getActiveFile()): void {
    if (!file) {
      new Notice("Нет активной заметки");
      return;
    }
    new ConnectionsModal(this.app, file, {
      includeBody: this.settings.includeBodyLinks,
      mocPattern: this.settings.mocPattern,
      types: this.settings.relationTypes,
      connect: () => this.connectFromActive(),
      changeType: (fromType, target) => this.changeLinkType(file, fromType, target),
    }).open();
  }

  // Иконка-звено в шапке каждой markdown-вью (нативный addAction). Дедуп по вью.
  refreshActions(): void {
    if (!this.settings.showButton) {
      this.removeActions();
      return;
    }
    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      const view = leaf.view;
      if (view instanceof MarkdownView && !this.actionViews.has(view)) {
        const el = view.addAction("link", "Ties: связи", () => {
          if (view.file) this.openConnectionsModal(view.file);
        });
        this.actionViews.add(view);
        this.actionEls.push(el);
      }
    }
  }

  removeActions(): void {
    for (const el of this.actionEls) el.remove();
    this.actionEls = [];
    this.actionViews = new WeakSet();
  }

  // Кандидаты для пикера, ранжированные по эмбеддингам (похожие сверху).
  private async rankedCandidates(source: TFile): Promise<ScoredFile[]> {
    const files = this.app.vault.getMarkdownFiles().filter((f) => f.path !== source.path);
    let scored: ScoredFile[] = files.map((f) => ({ file: f, score: null }));
    if (this.embIndex.size() > 1) {
      try {
        const q = await this.embIndex.ensure(source);
        const ranked = this.embIndex.similar(q, source.path, 999999);
        const rank = new Map(ranked.map((r) => [r.path, r.score]));
        scored = files.map((f) => ({ file: f, score: rank.get(f.path) ?? null }));
        scored.sort((a, b) => (b.score ?? -2) - (a.score ?? -2));
        void this.embIndex.save();
      } catch (e) {
        console.error("[ties] similarity unavailable", e);
        new Notice("Ollama недоступен — обычный поиск");
      }
    }
    return scored;
  }

  // Карта path -> ярлык существующей связи с source (для бейджа в пикере).
  // Исходящие показываем типом, входящие — со стрелкой "←type".
  private existingRels(source: TFile): Map<string, string> {
    const m = new Map<string, string>();
    const add = (path: string, label: string) => {
      const cur = m.get(path);
      if (!cur) m.set(path, label);
      else if (!cur.split(", ").includes(label)) m.set(path, cur + ", " + label);
    };
    const { outgoing, incoming } = computeConnections(this.app, source, false);
    for (const [type, files] of outgoing) for (const f of files) add(f.path, type);
    for (const [type, files] of incoming) for (const f of files) add(f.path, "←" + type);
    return m;
  }

  // Перечитать эмбеддинги изменённых заметок (из очереди debounce).
  private async flushReembed(): Promise<void> {
    const paths = [...this.reembedQueue];
    this.reembedQueue.clear();
    if (this.embIndex.size() === 0) return; // индекс пуст — не строим его из-за одной правки
    let changed = false;
    for (const p of paths) {
      const f = this.app.vault.getAbstractFileByPath(p);
      if (f instanceof TFile) {
        try {
          await this.embIndex.ensure(f);
          changed = true;
        } catch {
          /* Ollama недоступен — тихо пропускаем */
        }
      }
    }
    if (changed) void this.embIndex.save();
  }

  // Сменить тип исходящей связи source -> target (удаляем старую, пишем новую).
  async changeLinkType(source: TFile, fromType: string, target: TFile): Promise<void> {
    const all = this.settings.relationTypes.filter((t) => !isSystemType(t.name));
    const cur = all.find((t) => t.name === fromType);
    const list = cur ? [cur, ...all.filter((t) => t.name !== fromType)] : all;
    const to = await pickType(this.app, list, `Новый тип → ${target.basename}`);
    if (!to || to === fromType) return;
    await removeLink(this.app, source, fromType, target);
    await addLink(this.app, source, to, target);
    new Notice(`${fromType} → ${to}: ${target.basename}`);
  }

  // Переименовать тип во всех заметках: перенос ключа frontmatter old -> new.
  async migrateType(oldName: string, newName: string): Promise<number> {
    const files = this.app.vault.getMarkdownFiles();
    let count = 0;
    for (const f of files) {
      const fm = this.app.metadataCache.getFileCache(f)?.frontmatter;
      if (!fm || !(oldName in fm)) continue;
      await this.app.fileManager.processFrontMatter(f, (w) => {
        if (!(oldName in w)) return;
        const merged = mergeUnique(w[newName], w[oldName]);
        if (merged.length) w[newName] = merged;
        delete w[oldName];
      });
      count++;
    }
    return count;
  }

  // Добавить created (дата-время) в новую заметку, если его ещё нет.
  async stampCreated(file: TFile): Promise<void> {
    if (!this.settings.stampCreated) return;
    const prop = this.settings.createdProperty || "created";
    const fmt = this.settings.createdFormat || "YYYY-MM-DDTHH:mm";
    try {
      await this.app.fileManager.processFrontMatter(file, (fm) => {
        const cur = fm[prop];
        if (cur === undefined || cur === null || cur === "") {
          fm[prop] = moment().format(fmt);
        }
      });
    } catch (e) {
      console.error("[ties] stampCreated error", e);
    }
  }

  async connectFromActive(): Promise<void> {
    try {
      const source = this.app.workspace.getActiveFile();
      if (!source) {
        new Notice("Ties: нет активной заметки");
        return;
      }

      const isMocNote = isMoc(this.app, source, this.settings.mocPattern);

      const scored = await this.rankedCandidates(source);
      const relMap = this.existingRels(source);
      const scoredWithRel = scored.map((s) => ({ ...s, rel: relMap.get(s.file.path) ?? null }));

      const target = await pickSimilar(
        this.app,
        scoredWithRel,
        isMocNote ? "Кого добавить в карту · печатай для поиска" : "Похожие сверху · печатай для поиска"
      );
      if (!target) return;

      // На MOC связываем наоборот: выбранная заметка вступает в карту
      // (moc: [[MOC]] пишется в ЕЁ frontmatter), тип не спрашиваем — это членство.
      if (isMocNote) {
        const res = await addLink(this.app, target, "moc", source);
        new Notice(
          res === "added"
            ? `+ участник: ${target.basename}`
            : res === "exists"
            ? `${target.basename} уже в карте`
            : "Нельзя добавить саму карту"
        );
        return;
      }

      // Цель — MOC: обычная заметка вступает в карту, тип очевиден («moc»), не спрашиваем.
      if (isMoc(this.app, target, this.settings.mocPattern)) {
        const res = await addLink(this.app, source, "moc", target);
        new Notice(
          res === "added"
            ? `+ в карту: ${target.basename}`
            : res === "exists"
            ? `Уже в карте: ${target.basename}`
            : "Нельзя связать с собой"
        );
        return;
      }

      const selectable = this.settings.relationTypes.filter((t) => !isSystemType(t.name));
      const last = selectable.find((t) => t.name === this.lastType);
      const types = last
        ? [last, ...selectable.filter((t) => t.name !== this.lastType)]
        : selectable;
      const type = await pickType(this.app, types, "Тип связи · 1..9 или выбери");
      if (!type) return;
      this.lastType = type;

      const res = await addLink(this.app, source, type, target);
      new Notice(
        res === "added"
          ? `+ ${type} → ${target.basename}`
          : res === "exists"
          ? `Уже связано (${type})`
          : "Нельзя связать с собой"
      );
    } catch (e) {
      console.error("[ties] connect error", e);
      new Notice(`Ties: ошибка — ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.settings.relationTypes = normalizeTypes(this.settings.relationTypes);
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
}

class TiesSettingTab extends PluginSettingTab {
  plugin: TiesPlugin;

  constructor(app: App, plugin: TiesPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    const intro = containerEl.createDiv({ cls: "zk-intro" });
    intro.createEl("p", {
      text: "Ты решаешь связи — плагин делает механику: похожие по смыслу → тип → запись во frontmatter. Кнопка в углу заметки открывает её связи; у MOC — участники и орбита.",
    });
    new Setting(containerEl)
      .setName("Как пользоваться")
      .setDesc("Краткая справка по плагину.")
      .addButton((b) =>
        b.setButtonText("Справка").onClick(() => new HelpModal(this.app).open())
      );

    new Setting(containerEl).setName("Связи").setHeading();

    new Setting(containerEl)
      .setName("Типы связей")
      .setDesc('Имя + описание (видно в пикере и по кнопке «ⓘ типы» в модалке). Первый — дефолт.');

    const list = containerEl.createDiv({ cls: "zk-types-list" });
    this.plugin.settings.relationTypes.forEach((rt, i) => {
      const system = isSystemType(rt.name);
      const row = list.createDiv({ cls: "zk-type-row" });

      const name = row.createEl("input", {
        cls: "zk-type-name",
        attr: { type: "text", placeholder: "тип" },
      });
      name.value = rt.name;
      if (system) {
        name.disabled = true;
        name.title = "системный тип — нельзя изменить";
      } else {
        name.addEventListener("input", async () => {
          rt.name = name.value.trim();
          await this.plugin.saveSettings();
        });
      }

      const desc = row.createEl("input", {
        cls: "zk-type-desc",
        attr: { type: "text", placeholder: "описание" },
      });
      desc.value = rt.desc;
      desc.addEventListener("input", async () => {
        rt.desc = desc.value;
        await this.plugin.saveSettings();
      });

      if (system) {
        row.createSpan({ cls: "zk-type-system", text: "системный" });
        return;
      }

      const rename = row.createDiv({
        cls: "clickable-icon zk-type-del",
        attr: { "aria-label": "переименовать тип во всех заметках" },
      });
      setIcon(rename, "pencil");
      rename.addEventListener("click", async () => {
        const from = rt.name;
        if (!from) {
          new Notice("Сначала задай имя типа");
          return;
        }
        if (from === "moc") {
          new Notice("moc — служебный тип, переименование сломает MOC");
          return;
        }
        const val = await promptText(this.app, {
          title: `Переименовать «${from}» во всех заметках`,
          value: from,
          placeholder: "новое имя типа",
          cta: "Переименовать",
        });
        if (val == null) return;
        const to = val.trim();
        if (!to || to === from) return;
        if (to === "moc") {
          new Notice("Нельзя переименовать в moc");
          return;
        }
        const notice = new Notice("Миграция типа…", 0);
        const n = await this.plugin.migrateType(from, to);
        rt.name = to;
        await this.plugin.saveSettings();
        notice.setMessage(`Готово: обновлено заметок — ${n}`);
        setTimeout(() => notice.hide(), 3000);
        this.display();
      });

      const del = row.createDiv({
        cls: "clickable-icon zk-type-del",
        attr: { "aria-label": "удалить" },
      });
      setIcon(del, "trash");
      del.addEventListener("click", async () => {
        this.plugin.settings.relationTypes.splice(i, 1);
        await this.plugin.saveSettings();
        this.display();
      });
    });

    const addRow = list.createDiv({ cls: "zk-type-add" });
    const addBtn = addRow.createEl("button", { text: "+ тип" });
    addBtn.addEventListener("click", async () => {
      this.plugin.settings.relationTypes.push({ name: "", desc: "" });
      await this.plugin.saveSettings();
      this.display();
    });

    new Setting(containerEl)
      .setName("Паттерн MOC")
      .setDesc("Как опознавать MOC-заметки по имени файла (напр. «MOC *»).")
      .addText((t) =>
        t.setValue(this.plugin.settings.mocPattern).onChange(async (v) => {
          this.plugin.settings.mocPattern = v.trim();
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Кнопка связей в шапке заметки")
      .setDesc("Иконка-звено в правом верхнем углу заметки (рядом с «…»). Открывает связи. ПК и мобилка.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.showButton).onChange(async (v) => {
          this.plugin.settings.showButton = v;
          await this.plugin.saveSettings();
          this.plugin.refreshActions();
        })
      );

    new Setting(containerEl)
      .setName("Учитывать ссылки из тела")
      .setDesc("Показывать обычные [[ссылки]] из текста рядом с frontmatter-связями.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.includeBodyLinks).onChange(async (v) => {
          this.plugin.settings.includeBodyLinks = v;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl).setName("Дата создания").setHeading();

    new Setting(containerEl)
      .setName("Штамп created для новых заметок")
      .setDesc("Добавлять дату-время в frontmatter при создании заметки (без шаблонов). Существующие не трогаются.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.stampCreated).onChange(async (v) => {
          this.plugin.settings.stampCreated = v;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Свойство")
      .setDesc("Имя поля во frontmatter.")
      .addText((t) =>
        t.setValue(this.plugin.settings.createdProperty).onChange(async (v) => {
          this.plugin.settings.createdProperty = v.trim() || "created";
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Формат")
      .setDesc("Токены moment: YYYY-MM-DD, HH:mm, ss. Напр. YYYY-MM-DDTHH:mm.")
      .addText((t) =>
        t.setValue(this.plugin.settings.createdFormat).onChange(async (v) => {
          this.plugin.settings.createdFormat = v.trim() || "YYYY-MM-DDTHH:mm";
          await this.plugin.saveSettings();
        })
      );

    const ro = this.plugin.settings.readOnlyEmbeddings;
    new Setting(containerEl)
      .setName("Похожие по смыслу")
      .setDesc(
        ro
          ? "Режим потребителя: эмбеддинги считает сервер, устройство только читает кэш."
          : "Режим локального подсчёта: эмбеддинги считает Ollama на этом устройстве."
      )
      .setHeading();

    // Переключатель режима — общий
    new Setting(containerEl)
      .setName("Кэш только для чтения")
      .setDesc(
        "Плагин только читает синхронизированный ties-embeddings.bin (эмбеддинги считает сервер-индексер). Включи на устройствах-потребителях; выключи там, где считаешь локально."
      )
      .addToggle((t) =>
        t.setValue(ro).onChange(async (v) => {
          this.plugin.settings.readOnlyEmbeddings = v;
          await this.plugin.saveSettings();
          if (v) await this.plugin.deployIndexer();
          this.display();
        })
      );

    // Папка кэша — нужна в обоих режимах
    new Setting(containerEl)
      .setName("Папка кэша эмбеддингов")
      .setDesc(
        ro
          ? "Папка, где лежит синхронизированный ties-embeddings.bin (относительно корня вульта)."
          : "Папка, где хранить ties-embeddings.bin (относительно корня вульта). Пусто — рядом с плагином. Для синхронизации укажи синхронизируемую папку. Применяется при потере фокуса поля."
      )
      .addText((t) => {
        t.setPlaceholder(this.plugin.manifest.dir ?? "")
          .setValue(this.plugin.settings.embeddingsPath)
          .onChange(async (v) => {
            this.plugin.settings.embeddingsPath = v.trim();
            await this.plugin.saveSettings();
          });
        t.inputEl.addEventListener("blur", async () => {
          await this.plugin.embIndex.relocate(this.plugin.embeddingsCachePath());
        });
      });

    if (ro) {
      // Потребитель: считает сервер
      new Setting(containerEl)
        .setName("Индексер для сервера")
        .setDesc(
          "Эмбеддинги считает сервер этим индексером. Кнопка кладёт ties-indexer.mjs в папку кэша — через синхронизацию он попадёт на сервер, где: node ties-indexer.mjs --watch"
        )
        .addButton((b) =>
          b.setButtonText("Разложить индексер").onClick(() => this.plugin.deployIndexer())
        );
    } else {
      // Писатель: локальный Ollama
      new Setting(containerEl).setName("Ollama URL").addText((t) =>
        t.setValue(this.plugin.settings.ollamaUrl).onChange(async (v) => {
          this.plugin.settings.ollamaUrl = v.trim();
          await this.plugin.saveSettings();
        })
      );

      new Setting(containerEl)
        .setName("Модель эмбеддингов")
        .setDesc("Например bge-m3 (сначала `ollama pull bge-m3`).")
        .addText((t) =>
          t.setValue(this.plugin.settings.ollamaModel).onChange(async (v) => {
            this.plugin.settings.ollamaModel = v.trim();
            await this.plugin.saveSettings();
          })
        );

      new Setting(containerEl)
        .setName("Обновлять похожие при правке")
        .setDesc("Перечитывать эмбеддинг изменённой заметки автоматически (нужен запущенный Ollama). Индекс должен быть построен хотя бы раз.")
        .addToggle((t) =>
          t.setValue(this.plugin.settings.autoEmbed).onChange(async (v) => {
            this.plugin.settings.autoEmbed = v;
            await this.plugin.saveSettings();
          })
        );

      new Setting(containerEl)
        .setName("Индексер для сервера (опционально)")
        .setDesc(
          "Разложить standalone-индексер в папку кэша, если хочешь перенести подсчёт на сервер. Тогда на устройствах включи «Кэш только для чтения»."
        )
        .addButton((b) =>
          b.setButtonText("Разложить индексер").onClick(() => this.plugin.deployIndexer())
        );
    }
  }
}
