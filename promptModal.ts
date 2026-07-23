import { App, Modal } from "obsidian";

export interface PromptOpts {
  title: string;
  value?: string;
  placeholder?: string;
  cta?: string;
}

// Ввод короткого текста. Резолвит строку при сохранении, null при отмене/закрытии.
export function promptText(app: App, opts: PromptOpts): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v: string | null) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };

    class PromptModal extends Modal {
      onOpen(): void {
        const { contentEl } = this;
        contentEl.addClass("zk-prompt");
        this.titleEl.setText(opts.title);

        const ta = contentEl.createEl("textarea", { cls: "zk-prompt-input" });
        ta.value = opts.value ?? "";
        if (opts.placeholder) ta.placeholder = opts.placeholder;
        ta.rows = 3;

        const bar = contentEl.createDiv({ cls: "zk-confirm-bar" });
        const cancel = bar.createEl("button", { text: "Отмена" });
        cancel.addEventListener("click", () => {
          done(null);
          this.close();
        });
        const ok = bar.createEl("button", { text: opts.cta ?? "OK", cls: "mod-cta" });
        ok.addEventListener("click", () => {
          done(ta.value);
          this.close();
        });

        ta.addEventListener("keydown", (e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            done(ta.value);
            this.close();
          }
        });

        window.setTimeout(() => {
          ta.focus();
          ta.select();
        }, 0);
      }

      onClose(): void {
        this.contentEl.empty();
        done(null); // закрытие по Esc/фону = отмена
      }
    }

    new PromptModal(app).open();
  });
}
