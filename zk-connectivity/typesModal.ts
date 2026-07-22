import { App, Modal } from "obsidian";
import { RelType } from "./types";

export class TypesModal extends Modal {
  constructor(app: App, private types: RelType[]) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass("zk-help");
    contentEl.createEl("h3", { text: "Типы связей" });
    contentEl.createEl("p", {
      text: "Читается: «эта заметка [тип] цель». В футере «Исходящие» — что делает эта заметка, «Входящие» — что делают с ней.",
    });
    const ul = contentEl.createEl("ul");
    for (const t of this.types) {
      const li = ul.createEl("li");
      li.createEl("strong", { text: t.name });
      if (t.desc) li.appendText(" — " + t.desc);
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
