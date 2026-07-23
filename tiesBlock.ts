import { App, MarkdownRenderChild, TFile } from "obsidian";
import { renderConnectionsBody, renderMocButton } from "./renderConnections";
import { isMoc } from "./moc";
import { RelType } from "./types";
import { TypesModal } from "./typesModal";

export interface BlockDeps {
  includeBody: () => boolean;
  mocPattern: () => string;
  types: () => RelType[];
  connect: () => Promise<void>;
  changeType: (fromType: string, target: TFile) => Promise<void>;
}

// Рендер блока ```ties``` в теле заметки. Сам определяет MOC vs обычную.
// Живёт как MarkdownRenderChild — перерисовывается на изменения метаданных.
export class TiesBlock extends MarkdownRenderChild {
  constructor(
    private app: App,
    private file: TFile,
    private deps: BlockDeps,
    containerEl: HTMLElement
  ) {
    super(containerEl);
  }

  onload(): void {
    this.registerEvent(this.app.metadataCache.on("changed", () => this.render()));
    this.render();
  }

  private render(): void {
    const el = this.containerEl;
    el.empty();
    el.addClass("zk-block");

    const moc = isMoc(this.app, this.file, this.deps.mocPattern());
    const head = el.createDiv({ cls: "zk-block-head" });
    head.createSpan({ text: "Связи", cls: "zk-block-label" });
    const actions = head.createDiv({ cls: "zk-block-actions" });
    const add = actions.createEl("a", {
      text: moc ? "＋ участник" : "＋ связать",
      cls: "zk-block-add",
    });
    add.addEventListener("click", async (e) => {
      e.preventDefault();
      await this.deps.connect();
      this.render();
    });

    if (!moc) {
      renderMocButton(
        this.app,
        actions,
        this.file,
        this.deps.mocPattern(),
        (path) => this.app.workspace.openLinkText(path, this.file.path, false),
        true
      );
    }

    const body = el.createDiv({ cls: "zk-block-body" });
    renderConnectionsBody(this.app, body, this.file, {
      includeBody: this.deps.includeBody(),
      mocPattern: this.deps.mocPattern(),
      editable: true,
      onChange: () => this.render(),
      changeType: this.deps.changeType,
      onTypes: () => new TypesModal(this.app, this.deps.types()).open(),
      openLink: (path) => this.app.workspace.openLinkText(path, this.file.path, false),
    });
  }
}
