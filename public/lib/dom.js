export function renderInlineError(container, message) {
  const previous = container.querySelector(':scope > [data-inline-error]');
  previous?.remove();
  const error = document.createElement('div');
  error.className = 'pc-inline-error';
  error.dataset.inlineError = '';
  error.setAttribute('role', 'alert');
  error.textContent = message || '操作失败，请重试';
  container.prepend(error);
  return () => error.remove();
}

let dialogSequence = 0;
let closeActiveConfirmation = null;

function portalHost() {
  return document.getElementById('pc-root') || document.body;
}

function makeButton(action, text, className) {
  const button = document.createElement('button');
  button.type = 'button';
  button.dataset.action = action;
  button.className = className;
  button.textContent = text;
  return button;
}

export function requestConfirmation({
  title = '请确认', message, confirmLabel = '确定', cancelLabel = '取消', danger = false
} = {}) {
  closeActiveConfirmation?.(false);
  const previousFocus = document.activeElement;
  const overlay = document.createElement('div');
  overlay.className = 'pc-dialog-backdrop';
  overlay.dataset.role = 'confirm-backdrop';

  const dialog = document.createElement('section');
  const titleId = `pc-confirm-title-${++dialogSequence}`;
  const descriptionId = `${titleId}-description`;
  dialog.className = 'pc-dialog';
  dialog.dataset.role = 'confirm-dialog';
  dialog.setAttribute('role', 'alertdialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-labelledby', titleId);
  dialog.setAttribute('aria-describedby', descriptionId);

  const heading = document.createElement('h2');
  heading.id = titleId;
  heading.className = 'pc-dialog-title';
  heading.textContent = title;
  const description = document.createElement('p');
  description.id = descriptionId;
  description.className = 'pc-dialog-message';
  description.textContent = message || '';
  const actions = document.createElement('div');
  actions.className = 'pc-dialog-actions';
  const cancel = makeButton('confirm-dialog-cancel', cancelLabel, 'pc-btn-ghost');
  const confirm = makeButton(
    'confirm-dialog-confirm', confirmLabel, danger ? 'pc-btn-danger' : 'pc-btn-primary'
  );
  actions.append(cancel, confirm);
  dialog.append(heading, description, actions);
  overlay.append(dialog);
  const host = portalHost();
  host.append(overlay);

  let resolveResult;
  const result = new Promise(resolve => { resolveResult = resolve; });
  let settled = false;
  let removalObserver = null;

  function finish(confirmed) {
    if (settled) return;
    settled = true;
    removalObserver?.disconnect();
    overlay.remove();
    document.removeEventListener('keydown', onKeydown);
    closeActiveConfirmation = null;
    if (previousFocus?.isConnected && typeof previousFocus.focus === 'function') previousFocus.focus();
    resolveResult(Boolean(confirmed));
  }

  function onKeydown(event) {
    if (event.key === 'Escape') {
      event.preventDefault();
      finish(false);
      return;
    }
    if (event.key !== 'Tab') return;
    const controls = [cancel, confirm];
    const index = controls.indexOf(document.activeElement);
    if (event.shiftKey && index <= 0) {
      event.preventDefault();
      confirm.focus();
    } else if (!event.shiftKey && index === controls.length - 1) {
      event.preventDefault();
      cancel.focus();
    }
  }

  overlay.addEventListener('click', event => {
    if (event.target === overlay || event.target.closest('[data-action="confirm-dialog-cancel"]')) finish(false);
    if (event.target.closest('[data-action="confirm-dialog-confirm"]')) finish(true);
  });
  document.addEventListener('keydown', onKeydown);
  const MutationObserverClass = document.defaultView?.MutationObserver;
  if (MutationObserverClass) {
    removalObserver = new MutationObserverClass(() => {
      if (!overlay.isConnected) finish(false);
    });
    removalObserver.observe(host, { childList: true });
  }
  closeActiveConfirmation = finish;
  cancel.focus();
  return result;
}

export function showToast({ message, actionLabel = '', duration = 3000 } = {}) {
  const host = portalHost();
  let region = host.querySelector(':scope > [data-role="toast-region"]');
  if (!region) {
    region = document.createElement('div');
    region.className = 'pc-toast-region';
    region.dataset.role = 'toast-region';
    region.setAttribute('aria-live', 'polite');
    host.append(region);
  }

  const toast = document.createElement('div');
  toast.className = 'pc-toast';
  toast.dataset.role = 'toast';
  toast.setAttribute('role', 'status');
  const text = document.createElement('span');
  text.textContent = message || '';
  toast.append(text);
  if (actionLabel) toast.append(makeButton('toast-action', actionLabel, 'pc-toast-action'));
  region.append(toast);

  let resolveClosed;
  const closed = new Promise(resolve => { resolveClosed = resolve; });
  let settled = false;
  let timer;
  function close(reason = 'dismissed') {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    toast.remove();
    if (!region.children.length) region.remove();
    resolveClosed(reason);
  }
  toast.addEventListener('click', event => {
    if (event.target.closest('[data-action="toast-action"]')) close('action');
  });
  timer = setTimeout(() => close('timeout'), Math.max(0, Number(duration) || 0));
  return { element: toast, closed, close };
}
