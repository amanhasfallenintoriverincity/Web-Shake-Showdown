import React, { useEffect, useState } from 'react';
import {
  getOrientationReceptionDiagnostic,
  ORIENTATION_TRANSPORT_DIRECT,
} from '../orientationTransport';

const DIAGNOSTIC_REFRESH_MS = 250;

function OrientationTransportStatus({ playerId, receptions }) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const intervalId = window.setInterval(() => setNow(Date.now()), DIAGNOSTIC_REFRESH_MS);
    return () => window.clearInterval(intervalId);
  }, []);

  const diagnostic = getOrientationReceptionDiagnostic(receptions, playerId, now);
  const isDirect = diagnostic.transport === ORIENTATION_TRANSPORT_DIRECT;

  return (
    <div
      className={`orientation-transport-status ${isDirect ? 'is-direct' : 'is-fallback'} ${diagnostic.isStale ? 'is-stale' : ''}`}
      data-transport={diagnostic.transport}
      data-stale={diagnostic.isStale ? 'true' : 'false'}
      title="Host가 마지막으로 적용한 자세 패킷"
      aria-label={`${diagnostic.transport}, 마지막 패킷 ${diagnostic.ageLabel}`}
    >
      <span className="orientation-transport-status__path">
        <span className="orientation-transport-status__dot" aria-hidden="true" />
        {diagnostic.transport}
      </span>
      <span className="orientation-transport-status__age">
        마지막 패킷 {diagnostic.ageLabel}
      </span>
    </div>
  );
}

export default OrientationTransportStatus;
