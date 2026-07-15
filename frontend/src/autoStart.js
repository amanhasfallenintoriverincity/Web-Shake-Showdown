export const AUTO_START_DELAY_MS = 5_000;

export function isAutoStartEligible({
  gameState,
  totalPlayers,
  allPlayersReady,
  analysisReady,
  blocked = false,
}) {
  return gameState === 'waiting'
    && totalPlayers > 0
    && allPlayersReady
    && analysisReady
    && !blocked;
}

export function getAutoStartSecondsLeft(elapsedMs, delayMs = AUTO_START_DELAY_MS) {
  const safeElapsed = Number.isFinite(elapsedMs) ? Math.max(0, elapsedMs) : 0;
  const safeDelay = Number.isFinite(delayMs) ? Math.max(0, delayMs) : AUTO_START_DELAY_MS;
  return Math.max(0, Math.ceil((safeDelay - safeElapsed) / 1000));
}

export function scheduleAutoStart({
  onTick,
  onStart,
  now = () => Date.now(),
  setIntervalFn = (callback, delay) => globalThis.setInterval(callback, delay),
  setTimeoutFn = (callback, delay) => globalThis.setTimeout(callback, delay),
  clearIntervalFn = timerId => globalThis.clearInterval(timerId),
  clearTimeoutFn = timerId => globalThis.clearTimeout(timerId),
  delayMs = AUTO_START_DELAY_MS,
  tickMs = 250,
}) {
  const startedAt = now();
  const updateCountdown = () => {
    onTick(getAutoStartSecondsLeft(now() - startedAt, delayMs));
  };

  updateCountdown();
  const countdownTimer = setIntervalFn(updateCountdown, tickMs);
  const startTimer = setTimeoutFn(() => {
    onTick(0);
    onStart();
  }, delayMs);

  return () => {
    clearIntervalFn(countdownTimer);
    clearTimeoutFn(startTimer);
  };
}
