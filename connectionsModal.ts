import { App, EventRef, Modal, TFile } from "obsidian";
import { renderConnectionsBody } from "./renderConnections";
import { isMoc, nearestMoc } from "./moc";
import { RelType } from "./types";
import { TypesModal } from "./typesModal";

export interface ModalDeps {
  includeBody: boolean;
  mocPattern: string;
  types: RelType[];
  connect: () => Promise<void>;
  changeType: (fromType: string, target: TFile) => Promise<void>;
}

export class ConnectionsModal extends Modal {
  private ref: EventRef | null = null;

  constructor(app: App, private file: TFile, private deps: ModalDeps) {
    super(app);
  }

  onOpen(): void {
    this.ref = this.app.metadataCache.on("changed", () => this.render());
    this.render();
  }

  onClose(): void {
    if (this.ref) this.app.metadataCache.offref(this.ref);
    this.contentEl.empty();
  }

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("zk-modal");

    const moc = isMoc(this.app, this.file, this.deps.mocPattern);
    this.titleEl.setText(this.file.basename); // нативный заголовок модалки (иначе пустая тёмная полоса)
    const header = contentEl.createDiv({ cls: "zk-modal-header" });
    const bar = header.createDiv({ cls: "zk-modal-bar" });
    const add = bar.createEl("button", {
      text: moc ? "＋ участник" : "＋ связать",
      cls: "mod-cta",
    });
    add.addEventListener("click", async () => {
      await this.deps.connect();
      this.render();
    });
    const info = bar.createEl("button", { text: "ⓘ типы" });
    info.addEventListener("click", () => new TypesModal(this.app, this.deps.types).open());

    const near = moc ? null : nearestMoc(this.app, this.file, this.deps.mocPattern);
    if (near) {
      const mocBtn = bar.createEl("button", { text: `↑ ${near.basename}`, cls: "zk-moc-btn" });
      mocBtn.setAttribute("aria-label", "ближайший MOC");
      mocBtn.addEventListener("click", () => {
        this.close();
        this.app.workspace.openLinkText(near.path, "", false);
      });
    }

    const body = contentEl.createDiv({ cls: "zk-modal-body" });
    renderConnectionsBody(this.app, body, this.file, {
      includeBody: this.deps.includeBody,
      mocPattern: this.deps.mocPattern,
      editable: true,
      onChange: () => this.render(),
      changeType: this.deps.changeType,
      openLink: (path) => {
        this.close();
        this.app.workspace.openLinkText(path, "", false);
      },
    });
  }
}
