/**
 * In-page replacement for window.confirm / window.alert. Chrome draws native
 * dialogs inside the extension popup's 380px window and clips them (the OK
 * button ends up off-screen), so popup and side panel use this instead.
 */
export interface ConfirmOptions {
  title: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Style the confirm button as destructive. */
  danger?: boolean;
  /** Hide the cancel button (alert-style). */
  alertOnly?: boolean;
}

export function showConfirm(opts: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    const dialog = document.createElement("dialog");
    dialog.className = "confirm-dialog";

    const title = document.createElement("h2");
    title.className = "confirm-dialog-title";
    title.textContent = opts.title;
    dialog.appendChild(title);

    if (opts.message) {
      const message = document.createElement("p");
      message.className = "confirm-dialog-message";
      message.textContent = opts.message;
      dialog.appendChild(message);
    }

    const actions = document.createElement("div");
    actions.className = "confirm-dialog-actions";

    let result = false;
    const close = (value: boolean) => {
      result = value;
      dialog.close();
    };

    const confirmBtn = document.createElement("button");
    confirmBtn.type = "button";
    confirmBtn.className = opts.danger ? "danger" : "";
    confirmBtn.textContent = opts.confirmLabel ?? "OK";
    confirmBtn.addEventListener("click", () => close(true));

    if (!opts.alertOnly) {
      const cancelBtn = document.createElement("button");
      cancelBtn.type = "button";
      cancelBtn.className = "secondary";
      cancelBtn.textContent = opts.cancelLabel ?? "Cancel";
      cancelBtn.addEventListener("click", () => close(false));
      actions.appendChild(cancelBtn);
    }
    actions.appendChild(confirmBtn);
    dialog.appendChild(actions);

    // Escape fires "cancel" and closes with result still false.
    dialog.addEventListener("close", () => {
      dialog.remove();
      resolve(opts.alertOnly ? true : result);
    });
    dialog.addEventListener("click", (event) => {
      // Clicking the backdrop (outside the dialog box) cancels.
      if (event.target === dialog) {
        close(false);
      }
    });

    document.body.appendChild(dialog);
    dialog.showModal();
    // Destructive actions default to Cancel so Enter doesn't delete by accident.
    const focusTarget = opts.danger
      ? (actions.querySelector("button.secondary") as HTMLButtonElement | null)
      : confirmBtn;
    (focusTarget ?? confirmBtn).focus();
  });
}

export async function showAlert(title: string, message?: string): Promise<void> {
  await showConfirm({ title, message, alertOnly: true });
}
