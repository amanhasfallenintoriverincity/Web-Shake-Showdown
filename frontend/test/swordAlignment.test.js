import assert from 'node:assert/strict';
import test from 'node:test';

import { getSwordAlignmentGuide } from '../src/swordAlignment.js';

test('정면을 향한 휴대폰은 검 정렬 완료로 판정한다', () => {
  const guide = getSwordAlignmentGuide({ beta: 90, gamma: 0 });

  assert.equal(guide.aligned, true);
  assert.equal(guide.score, 100);
  assert.equal(guide.instruction, '좋아요! 검이 정면에 맞았습니다.');
  assert.deepEqual(guide.preview, { rotateX: 0, rotateZ: 0, shiftX: 0 });
});

test('좌우로 기울어진 휴대폰은 반대 방향 보정을 안내한다', () => {
  const rightTilt = getSwordAlignmentGuide({ beta: 90, gamma: 24 });
  const leftTilt = getSwordAlignmentGuide({ beta: 90, gamma: -24 });

  assert.equal(rightTilt.aligned, false);
  assert.equal(rightTilt.instruction, '휴대폰을 왼쪽으로 천천히 기울이세요.');
  assert.ok(rightTilt.preview.rotateZ > 0);
  assert.equal(leftTilt.instruction, '휴대폰을 오른쪽으로 천천히 기울이세요.');
  assert.ok(leftTilt.preview.rotateZ < 0);
});

test('너무 눕거나 낮은 휴대폰은 세로 각도 보정을 안내한다', () => {
  assert.equal(
    getSwordAlignmentGuide({ beta: 62, gamma: 0 }).instruction,
    '휴대폰을 조금 더 세워주세요.',
  );
  assert.equal(
    getSwordAlignmentGuide({ beta: 122, gamma: 0 }).instruction,
    '휴대폰 위쪽을 몸 쪽으로 조금 당겨주세요.',
  );
});

test('센서 값이 없으면 안전한 기본값과 센서 대기 상태를 반환한다', () => {
  const guide = getSwordAlignmentGuide({ beta: null, gamma: undefined });

  assert.equal(guide.hasSensorReading, false);
  assert.equal(guide.aligned, false);
  assert.equal(guide.score, 0);
  assert.equal(guide.instruction, '휴대폰을 움직여 센서를 깨워주세요.');
});

test('미세한 센서 오차는 정렬 완료 범위로 허용한다', () => {
  const guide = getSwordAlignmentGuide({ beta: 99, gamma: -8 });

  assert.equal(guide.aligned, true);
  assert.ok(guide.score >= 70);
});
