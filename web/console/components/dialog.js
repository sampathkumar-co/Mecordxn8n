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

// Own asynchronous form failures in one place, including network/timeouts.
// Event handlers execute synchronously until their first await so FormData
// can still access event.currentTarget before the browser clears it.
export function onSubmit(form, action) {
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (form.dataset.submitting === "1") return;
    const button = event.submitter instanceof HTMLButtonElement ? event.submitter : null;
    if (button?.disabled) return;
    form.dataset.submitting = "1";
    form.setAttribute("aria-busy", "true");
    if (button) button.disabled = true;
    let result;
    try {
      result = action(event);
    } catch (error) {
      result = Promise.reject(error);
    }
    Promise.resolve(result)
      .catch((error) => toast(error?.message || "Action failed. Please try again.", true))
      .finally(() => {
        delete form.dataset.submitting;
        form.removeAttribute("aria-busy");
        if (button?.isConnected) button.disabled = false;
      });
  });
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
