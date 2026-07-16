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
