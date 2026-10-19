// Keep drop positions independent of separators, placeholders and extra icons.
// Centers are in the same (stage) coordinate system as the drag event.
export const getDropSlot = (pointer, centers, reversed = false) => {
  if (!Number.isFinite(pointer)) return null;
  let slot = 0;
  for (const center of centers) {
    if (!Number.isFinite(center)) return null;
    if (reversed ? pointer < center : pointer > center) slot++;
  }
  return slot;
};

export const planFavoriteDrop = (ids, sourceId, slot) => {
  const sourceIndex = ids.indexOf(sourceId);
  const remaining = ids.filter(id => id !== sourceId);
  const boundedSlot = Math.max(0, Math.min(ids.length, slot));
  const position = boundedSlot -
    (sourceIndex !== -1 && sourceIndex < boundedSlot ? 1 : 0);
  return {
    position,
    beforeId: remaining[position] ?? null,
    afterId: remaining[position - 1] ?? null,
    unchanged: sourceIndex === position,
  };
};

// Favorites can change between button release and BEFORE_REDRAW. Anchor the
// insertion to its neighbours rather than applying a stale numeric index.
export const resolveFavoriteDrop = (ids, sourceId, plan) => {
  const remaining = ids.filter(id => id !== sourceId);
  let position = remaining.indexOf(plan.beforeId);
  if (position !== -1) return position;
  position = remaining.indexOf(plan.afterId);
  if (position !== -1) return position + 1;
  return Math.max(0, Math.min(remaining.length, plan.position));
};
