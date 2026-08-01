function finite(value, fallback = 0) {
  return Number.isFinite(Number(value)) ? Number(value) : fallback;
}

function clamp(value, minimum, maximum) {
  return Math.min(Math.max(value, minimum), Math.max(minimum, maximum));
}

export function anchoredPanelPosition({
  anchorRect,
  panelRect,
  viewportWidth,
  viewportHeight,
  margin = 12,
  gap = 8
}) {
  const safeMargin = Math.max(0, finite(margin, 12));
  const safeGap = Math.max(0, finite(gap, 8));
  const width = Math.min(
    Math.max(0, finite(panelRect?.width)),
    Math.max(0, finite(viewportWidth) - safeMargin * 2)
  );
  const height = Math.min(
    Math.max(0, finite(panelRect?.height)),
    Math.max(0, finite(viewportHeight) - safeMargin * 2)
  );
  const minimumTop = safeMargin;
  const maximumTop = Math.max(minimumTop, finite(viewportHeight) - height - safeMargin);
  const below = finite(anchorRect?.bottom, safeMargin) + safeGap;
  const above = finite(anchorRect?.top, below) - safeGap - height;
  const top = below <= maximumTop
    ? below
    : above >= minimumTop && above <= maximumTop
      ? above
      : clamp(below, minimumTop, maximumTop);
  return {
    left: clamp(
      finite(anchorRect?.left, safeMargin),
      safeMargin,
      finite(viewportWidth) - width - safeMargin
    ),
    top
  };
}
