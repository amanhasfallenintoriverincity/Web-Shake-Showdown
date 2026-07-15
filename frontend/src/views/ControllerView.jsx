import React, { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { io } from 'socket.io-client';
import { RotateCcw, Smartphone } from 'lucide-react';
import SwordAlignmentGuide from '../components/SwordAlignmentGuide';
import { createOrientationPublisher } from '../orientationTransport';
import { createScreenWakeLock } from '../screenWakeLock';
import { vibrateOnHit } from '../hitHaptics';

const BACKEND_URL = '/';

const ControllerView = () => {
  const [searchParams] = useSearchParams();
  const roomIdFromUrl = searchParams.get('roomId');

  const [roomId, setRoomId] = useState(roomIdFromUrl || '');
  const [status, setStatus] = useState('disconnected');
  const [alignmentStage, setAlignmentStage] = useState('idle');
  const [orientation, setOrientation] = useState({ alpha: null, beta: null, gamma: null });
  const [color, setColor] = useState('#fff');
  const [errorMsg, setErrorMsg] = useState('');
  const [eventCount, setEventCount] = useState(0);

  const roomIdRef = useRef(roomId);
  const socketRef = useRef(null);
  const publishOrientationRef = useRef(null);
  const wakeLockRef = useRef(null);
  const lastUiUpdateTime = useRef(0);
  const eventCountRef = useRef(0);
  const rawOrientationRef = useRef({ alpha: 0, beta: 0, gamma: 0 });
  const offsetRef = useRef({ alpha: 0, beta: 0, gamma: 0 });

  if (!publishOrientationRef.current) publishOrientationRef.current = createOrientationPublisher();
  if (!wakeLockRef.current) wakeLockRef.current = createScreenWakeLock();

  useEffect(() => {
    roomIdRef.current = roomId;
  }, [roomId]);

  const handleOrientation = React.useCallback((event) => {
    rawOrientationRef.current = {
      alpha: event.alpha ?? 0,
      beta: event.beta ?? 0,
      gamma: event.gamma ?? 0,
    };

    // Heading is relative to the direction saved during calibration. Pitch and roll
    // stay absolute so an upright phone continues to mean beta=90 and gamma=0.
    const relativeAlpha =
      ((rawOrientationRef.current.alpha - offsetRef.current.alpha) % 360 + 540) % 360 - 180;
    const data = {
      alpha: relativeAlpha,
      beta: rawOrientationRef.current.beta,
      gamma: rawOrientationRef.current.gamma,
    };

    eventCountRef.current += 1;

    // Keep diagnostics and the guide smooth without rendering React at sensor frequency.
    const now = performance.now();
    if (now - lastUiUpdateTime.current >= 100) {
      lastUiUpdateTime.current = now;
      setOrientation(data);
      setEventCount(eventCountRef.current);
    }

    publishOrientationRef.current(socketRef.current, roomIdRef.current, data);
  }, []);

  const completeCalibration = () => {
    offsetRef.current = { ...rawOrientationRef.current };
    setAlignmentStage('ready');
    socketRef.current?.emit('calibration_completed', { roomId: roomIdRef.current });
  };

  const beginCalibration = () => {
    setAlignmentStage('aligning');
    socketRef.current?.emit('calibration_started', { roomId: roomIdRef.current });
  };

  useEffect(() => {
    return () => {
      socketRef.current?.disconnect();
      void wakeLockRef.current?.stop();
      window.removeEventListener('deviceorientation', handleOrientation);
    };
  }, [handleOrientation]);

  const connectToServer = () => {
    if (!roomId) {
      setErrorMsg('방 코드를 입력해주세요.');
      return;
    }

    setStatus('connecting');
    setErrorMsg('');
    socketRef.current?.disconnect();
    socketRef.current = io(BACKEND_URL, { transports: ['websocket'] });
    const socket = socketRef.current;

    socket.on('connect', () => {
      socket.emit('join_room', { roomId });
    });

    socket.on('joined', (data) => {
      setStatus('connected');
      setColor(data.color);
      setAlignmentStage('aligning');
      socket.emit('calibration_started', { roomId: data.roomId });
    });

    socket.on('hit_feedback', () => {
      vibrateOnHit();
    });

    socket.on('room_error', (msg) => {
      setStatus('error');
      setAlignmentStage('idle');
      setErrorMsg(msg);
      void wakeLockRef.current.stop();
      socket.disconnect();
    });

    socket.on('game_ended', () => {
      roomIdRef.current = '';
      setRoomId('');
      setStatus('disconnected');
      setAlignmentStage('idle');
      setErrorMsg('게임이 종료되었습니다. 화면의 새 QR 코드를 스캔하세요.');
      window.removeEventListener('deviceorientation', handleOrientation);
      void wakeLockRef.current.stop();
      socket.disconnect();
    });

    socket.on('host_disconnected', () => {
      setStatus('disconnected');
      setAlignmentStage('idle');
      setErrorMsg('호스트 연결이 끊어졌습니다. 게임 화면을 확인해주세요.');
      void wakeLockRef.current.stop();
      socket.disconnect();
    });
  };

  const connectAndRequestPermission = async () => {
    void wakeLockRef.current.start();

    if (
      typeof DeviceOrientationEvent !== 'undefined'
      && typeof DeviceOrientationEvent.requestPermission === 'function'
    ) {
      try {
        const permissionState = await DeviceOrientationEvent.requestPermission();
        if (permissionState === 'granted') {
          window.removeEventListener('deviceorientation', handleOrientation);
          window.addEventListener('deviceorientation', handleOrientation);
          connectToServer();
        } else {
          setErrorMsg('동작 센서 권한이 필요합니다. 브라우저 설정에서 허용해주세요.');
        }
      } catch (error) {
        console.error(error);
        setErrorMsg('센서 권한을 열 수 없습니다. HTTPS 주소인지 확인해주세요.');
      }
    } else {
      window.removeEventListener('deviceorientation', handleOrientation);
      window.addEventListener('deviceorientation', handleOrientation);
      connectToServer();
    }
  };

  const showJoinPanel = status === 'disconnected' || status === 'error' || status === 'connecting';

  return (
    <div
      className={`controller-ui ${alignmentStage === 'ready' ? 'is-playing' : ''}`}
      style={{ '--player-color': color }}
    >
      {showJoinPanel ? (
        <div className="controller-connect-panel">
          <div className="connect-icon"><Smartphone size={42} /></div>
          <span className="alignment-kicker">WEB SHAKE SHOWDOWN</span>
          <h1>휴대폰을<br />검으로 연결</h1>
          <p>게임 화면에 표시된 방 코드를 입력하세요.</p>

          <input
            aria-label="방 코드"
            type="text"
            placeholder="ROOM CODE"
            value={roomId}
            onChange={(event) => setRoomId(event.target.value.toUpperCase())}
          />

          {errorMsg && <p className="controller-error">{errorMsg}</p>}

          <button
            className="controller-connect-button"
            disabled={status === 'connecting'}
            onClick={connectAndRequestPermission}
            type="button"
          >
            {status === 'connecting' ? '연결 중…' : '센서 연결하기'}
          </button>
        </div>
      ) : alignmentStage === 'aligning' ? (
        <SwordAlignmentGuide orientation={orientation} onConfirm={completeCalibration} />
      ) : (
        <section className="controller-play-ready">
          <span className="play-ready-label">CONTROLLER READY</span>
          <h1>SWING!</h1>
          <p>연결 완료 · 휴대폰을 검처럼 휘두르세요</p>

          <div className="play-ready-sword" aria-hidden="true">
            <span className="play-ready-blade" />
            <span className="play-ready-guard" />
            <span className="play-ready-grip" />
          </div>

          <div className="sensor-data">
            <span>α {orientation.alpha?.toFixed(1)}°</span>
            <span>β {orientation.beta?.toFixed(1)}°</span>
            <span>γ {orientation.gamma?.toFixed(1)}°</span>
            <small>{eventCount} sensor events</small>
          </div>

          <button className="recalibrate-button" type="button" onClick={beginCalibration}>
            <RotateCcw size={18} /> 다시 정렬
          </button>
        </section>
      )}
    </div>
  );
};

export default ControllerView;
