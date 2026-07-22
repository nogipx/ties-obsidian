import { App, Component, MarkdownRenderer, Modal, TFile } from "obsidian";

// Полный предпросмотр заметки (скроллится). Открывается поверх пикера.
export class NotePreviewModal extends Modal {
  private comp = new Component();

  constructor(app: App, private file: TFile) {
    super(app);
  }

  async onOpen(): Promise<void> {
    this.modalEl.addClass("zk-preview-modal");
    const { contentEl } = this;
    contentEl.addClass("zk-preview");
    contentEl.createEl("h3", { text: this.file.basename, cls: "zk-preview-title" });
    const body = contentEl.createDiv({ cls: "zk-preview-body markdown-rendered" });
    this.comp.load();
    try {
      const md = await this.app.vault.cachedRead(this.file);
      await MarkdownRenderer.render(this.app, md, body, this.file.path, this.comp);
    } catch {
      body.setText("Не удалось загрузить заметку.");
    }
  }

  onClose(): void {
    this.comp.unload();
    this.contentEl.empty();
  }
}
