const TARGET_BETA = 90;
const MAX_PITCH_ERROR = 12;
const MAX_ROLL_ERROR = 10;

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const isSensorValue = (value) => typeof value === 'number' && Number.isFinite(value);

export function getSwordAlignmentGuide({ beta, gamma } = {}) {
  if (!isSensorValue(beta) || !isSensorValue(gamma)) {
    return {
      hasSensorReading: false,
      aligned: false,
      score: 0,
      instruction: '휴대폰을 움직여 센서를 깨워주세요.',
      preview: { rotateX: 0, rotateZ: 0, shiftX: 0 },
    };
  }

  const pitchError = beta - TARGET_BETA;
  const rollError = gamma;
  const aligned = Math.abs(pitchError) <= MAX_PITCH_ERROR && Math.abs(rollError) <= MAX_ROLL_ERROR;
  const score = Math.round(clamp(100 - Math.hypot(pitchError, rollError) * 2, 0, 100));

  let instruction = '좋아요! 검이 정면에 맞았습니다.';
  if (!aligned && Math.abs(rollError) > MAX_ROLL_ERROR) {
    instruction = rollError > 0
      ? '휴대폰을 왼쪽으로 천천히 기울이세요.'
      : '휴대폰을 오른쪽으로 천천히 기울이세요.';
  } else if (!aligned && pitchError < -MAX_PITCH_ERROR) {
    instruction = '휴대폰을 조금 더 세워주세요.';
  } else if (!aligned && pitchError > MAX_PITCH_ERROR) {
    instruction = '휴대폰 위쪽을 몸 쪽으로 조금 당겨주세요.';
  }

  return {
    hasSensorReading: true,
    aligned,
    score,
    instruction,
    preview: {
      rotateX: clamp(pitchError * 0.55, -32, 32),
      rotateZ: clamp(rollError * 0.8, -40, 40),
      shiftX: clamp(rollError * 0.35, -12, 12),
    },
  };
}
