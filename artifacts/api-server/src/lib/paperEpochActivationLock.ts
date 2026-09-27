let held = false;
export function isPaperEpochActivationHeld(): boolean { return held; }
export function tryAcquirePaperEpochActivationLock(): boolean {
  if (held) return false;
  held = true;
  return true;
}
export function releasePaperEpochActivationLock(): void { held = false; }