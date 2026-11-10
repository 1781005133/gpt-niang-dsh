// DSH menu refresh must expose its asynchronous queued/running result. The
// original Codex action and automatic visibility refresh keep their old scene.
export function showCompanionRefreshFeedback(scene, { hostSource, manual = false } = {}) {
  if (hostSource !== 'dsh' || manual !== true) return false;
  scene.show('quota');
  return true;
}
