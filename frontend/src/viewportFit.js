export function getViewportFitScale({
  viewportWidth,
  viewportHeight,
  panelWidth,
  panelHeight,
  inset = 16,
}) {
  if (panelWidth <= 0 || panelHeight <= 0) return 1;

  const availableWidth = Math.max(0, viewportWidth - inset * 2);
  const availableHeight = Math.max(0, viewportHeight - inset * 2);

  return Math.min(
    1,
    availableWidth / panelWidth,
    availableHeight / panelHeight,
  );
}

export function fitPanelToViewport(panel, viewport, inset = 16) {
  const scale = getViewportFitScale({
    viewportWidth: viewport.clientWidth,
    viewportHeight: viewport.clientHeight,
    panelWidth: panel.offsetWidth,
    panelHeight: panel.offsetHeight,
    inset,
  });

  panel.style.setProperty('--viewport-fit-scale', String(scale));
  return scale;
}
