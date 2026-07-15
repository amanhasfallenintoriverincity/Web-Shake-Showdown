import { Check, Move3D, Smartphone } from 'lucide-react';
import { getSwordAlignmentGuide } from '../swordAlignment';

function SwordAlignmentGuide({ orientation, onConfirm }) {
  const guide = getSwordAlignmentGuide(orientation);
  const { rotateX, rotateZ, shiftX } = guide.preview;

  return (
    <section className="sword-alignment-guide" data-aligned={guide.aligned} aria-live="polite">
      <header className="alignment-header">
        <div className="alignment-brand-icon" aria-hidden="true">
          <Move3D size={23} strokeWidth={2.4} />
        </div>
        <div>
          <span className="alignment-kicker">SHAKE SETUP</span>
          <p>플레이 준비</p>
        </div>
      </header>

      <div className="alignment-copy">
        <span className="step-pill">1</span>
        <div>
          <h1>휴대폰이 정면을<br />향하게 해주세요</h1>
          <p>화면을 바라본 채 세로로 들고, 실제 검을 점선 예시에 겹쳐주세요.</p>
        </div>
      </div>

      <div className="alignment-stage" aria-label="현재 휴대폰과 검의 정렬 상태 미리보기">
        <div className="alignment-orbit alignment-orbit-outer" />
        <div className="alignment-orbit alignment-orbit-inner" />
        <div className="target-axis target-axis-horizontal" />
        <div className="target-axis target-axis-vertical" />

        <div className="target-sword" aria-hidden="true">
          <span className="target-blade" />
          <span className="target-guard" />
          <span className="target-grip" />
        </div>

        <div
          className="phone-sword-preview"
          style={{
            '--preview-rotate-x': `${rotateX}deg`,
            '--preview-rotate-z': `${rotateZ}deg`,
            '--preview-shift-x': `${shiftX}px`,
          }}
        >
          <div className="preview-phone-screen">
            <span className="preview-speaker" />
            <div className="live-sword">
              <span className="live-blade" />
              <span className="live-guard" />
              <span className="live-grip" />
              <span className="live-pommel" />
            </div>
            <Smartphone className="preview-phone-icon" size={18} strokeWidth={2.4} />
          </div>
        </div>

        {guide.aligned && (
          <div className="alignment-success-burst" aria-hidden="true">
            <Check size={30} strokeWidth={3.5} />
          </div>
        )}
      </div>

      <div className={`alignment-status ${guide.aligned ? 'is-aligned' : ''}`}>
        <div className="alignment-meter-label">
          <span><Move3D size={17} /> 검 정렬도</span>
          <strong>{guide.score}%</strong>
        </div>
        <div className="alignment-meter" aria-hidden="true">
          <span style={{ width: `${guide.score}%` }} />
        </div>
        <p>{guide.instruction}</p>
      </div>

      <button
        className="alignment-confirm"
        type="button"
        disabled={!guide.aligned}
        onClick={onConfirm}
      >
        <span className="button-key">A</span>
        {guide.aligned ? '이 각도로 정렬하고 시작' : '점선 검에 맞춰주세요'}
      </button>
      <p className="alignment-footnote">정렬하면 지금 방향이 검의 정면으로 저장됩니다.</p>
    </section>
  );
}

export default SwordAlignmentGuide;
