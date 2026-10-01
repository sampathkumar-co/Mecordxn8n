import { $, toast } from "./ui.js";

let restoreFocus = null;

function rememberFocus() {
  restoreFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
}

function restore() {
  const node = restoreFocus;
  restoreFocus = null;
  if (node?.isConnected) node.focus();
}

export function openModal(title, kicker, html) {
  const modal = $("#modal");
  rememberFocus();
  $("#modal-title").textContent = title;
  $("#modal-kicker").textContent = kicker;
  $("#modal-content").innerHTML = html;
  modal.showModal();
}

export function closeModal() {
  const modal = $("#modal");
  if (modal?.open) modal.close();
}

export function openDrawer(title, kicker, html) {
  const drawer = $("#drawer");
  rememberFocus();
  $("#drawer-title").textContent = title;
  $("#drawer-kicker").textContent = kicker;
  $("#drawer-content").innerHTML = html;
  drawer.showModal();
}

export function closeDrawer() {
  const drawer = $("#drawer");
  if (drawer?.open) drawer.close();
}

export async function confirmDecision({
  title,
  kicker = "CONFIRM DECISION",
  copy,
  confirmLabel = "Confirm",
  danger = false,
  onConfirm,
}) {
  openModal(title, kicker, `
    <p>${copy}</p>
    <div class="form-actions">
      <button id="decision-cancel" class="button" type="button">Cancel</button>
      <button id="decision-confirm" class="button ${danger ? "danger" : "primary"}" type="button">${confirmLabel}</button>
    </div>`);
  $("#decision-cancel").addEventListener("click", closeModal);
  $("#decision-confirm").addEventListener("click", async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      await onConfirm();
      closeModal();
    } catch (error) {
      button.disabled = false;
      toast(error.message, true);
    }
  });
}

document.querySelectorAll("[data-close-dialog]").forEach((button) => {
  button.addEventListener("click", () => {
    document.getElementById(button.dataset.closeDialog)?.close();
  });
});

for (const id of ["modal", "drawer"]) {
  const dialog = document.getElementById(id);
  dialog?.addEventListener("close", restore);
  dialog?.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close();
  });
}
