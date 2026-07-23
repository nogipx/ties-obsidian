import { App, Modal } from "obsidian";

export interface ConfirmOpts {
  title: string;
  message?: string;
  cta?: string;
  danger?: boolean;
}

// Компактный диалог подтверждения. Резолвит true при подтверждении, false при отмене/закрытии.
export function confirm(app: App, opts: ConfirmOpts): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v: boolean) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };

    class ConfirmModal extends Modal {
      onOpen(): void {
        const { contentEl } = this;
        contentEl.addClass("zk-confirm");
        this.titleEl.setText(opts.title);
        if (opts.message) contentEl.createEl("p", { text: opts.message, cls: "zk-confirm-msg" });

        const bar = contentEl.createDiv({ cls: "zk-confirm-bar" });
        const cancel = bar.createEl("button", { text: "Отмена" });
        cancel.addEventListener("click", () => {
          done(false);
          this.close();
        });
        const ok = bar.createEl("button", {
          text: opts.cta ?? "OK",
          cls: opts.danger ? "mod-warning" : "mod-cta",
        });
        ok.addEventListener("click", () => {
          done(true);
          this.close();
        });
        ok.focus();
      }

      onClose(): void {
        this.contentEl.empty();
        done(false); // закрытие по Esc/фону = отмена
      }
    }

    new ConfirmModal(app).open();
  });
}
