import React, { startTransition, useCallback, useEffect, useLayoutEffect, useState, useRef } from 'react';
import { io } from 'socket.io-client';
import { QRCodeSVG } from 'qrcode.react';
import GameScene from '../components/GameScene';
import AlignmentGuide from '../components/AlignmentGuide';
import OrientationTransportStatus from '../components/OrientationTransportStatus';
import { pauseMusic, playHit, resumeMusic, startMusic, stopMusic } from '../audio';
import {
  isAutoStartEligible,
  scheduleAutoStart,
} from '../autoStart';
import { DEFAULT_BEATMAP } from '../defaultBeatmap';
import { analyzeMusicTrack } from '../musicAnalysis';
import {
  CALIBRATION_ALIGNING,
  CALIBRATION_READY,
  getCalibrationSummary,
  removePlayerCalibration,
  setPlayerCalibration,
} from '../calibrationState';
import {
  GAME_RESULT_DURATION_MS,
  getGameStateAfterMiss,
  incrementScore,
} from '../gameLogic';
import { fitPanelToViewport } from '../viewportFit';
import {
  createHostOrientationPeer,
  shouldAcceptRelayedOrientation,
  shouldResetHostRoomState,
} from '../webrtcOrientationPeer';
import {
  applyTrackedOrientationReception,
  initializeTrackedOrientation,
  ORIENTATION_TRANSPORT_DIRECT,
  ORIENTATION_TRANSPORT_FALLBACK,
} from '../orientationTransport';

// Use relative path to leverage Vite's proxy
const BACKEND_URL = '/';

const ANALYSIS_MESSAGES = {
  decoding: '음악 파일을 디코딩하고 있습니다…',
  analyzing: 'Essentia.js가 BPM, 박자, 에너지를 자동 분석하고 있습니다…',
  cached: '저장된 Essentia.js 분석 결과를 불러왔습니다.',
  complete: 'Essentia.js 자동 분석이 완료되었습니다.',
};

const HostView = () => {
  const [roomId, setRoomId] = useState(null);
  const [players, setPlayers] = useState({});
  const [scores, setScores] = useState({});
  const [playerCalibration, setPlayerCalibrationState] = useState({});
  const [gameState, setGameState] = useState('waiting'); // waiting, playing, finished
  const [finalResults, setFinalResults] = useState([]);
  const [beatmap, setBeatmap] = useState(DEFAULT_BEATMAP);
  const [analysisState, setAnalysisState] = useState({
    phase: 'loading',
    message: '음악 자동 분석을 준비하고 있습니다…',
  });
  const [selectedTrackName, setSelectedTrackName] = useState(DEFAULT_BEATMAP.title);
  const [audioError, setAudioError] = useState(null);
  const [resultSecondsLeft, setResultSecondsLeft] = useState(
    () => Math.ceil(GAME_RESULT_DURATION_MS / 1000)
  );
  const [autoStartSecondsLeft, setAutoStartSecondsLeft] = useState(null);
  const [debugData, setDebugData] = useState({});
  const socketRef = useRef(null);
  const roomIdRef = useRef(null);
  const scoresRef = useRef({});
  const replacingRoomRef = useRef(false);
  const finishGameRef = useRef(() => {});
  const analysisAbortRef = useRef(null);
  const customSongUrlRef = useRef(null);
  const viewportFitPanelRef = useRef(null);
  // Use a ref for high-frequency orientation data to avoid re-rendering HostView 60 times a second
  const playerOrientations = useRef({});
  const playerOrientationSequences = useRef({});
  const playerOrientationReceptions = useRef({});
  const orientationPeersRef = useRef(new Map());

  const closeAllOrientationPeers = useCallback(() => {
    for (const peerSession of orientationPeersRef.current.values()) {
      peerSession.close();
    }
    orientationPeersRef.current.clear();
  }, []);

  const applyPlayerOrientation = useCallback((playerId, data, sequence, transport) => {
    if (!applyTrackedOrientationReception({
      orientations: playerOrientations.current,
      sequences: playerOrientationSequences.current,
      receptions: playerOrientationReceptions.current,
      playerId,
      data,
      sequence,
      transport,
      receivedAt: Date.now(),
    })) return;

    // Throttled UI update to verify reception on screen (about 3 times a second).
    if (Math.random() < 0.1) {
      setDebugData(prev => ({ ...prev, [playerId]: data }));
    }
  }, []);

  useLayoutEffect(() => {
    const panel = viewportFitPanelRef.current;
    const viewport = panel?.parentElement;
    if (!panel || !viewport) return undefined;

    const fitPanel = () => fitPanelToViewport(panel, viewport);
    fitPanel();

    const resizeObserver = typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(fitPanel);
    resizeObserver?.observe(panel);
    resizeObserver?.observe(viewport);
    window.addEventListener('resize', fitPanel);
    window.visualViewport?.addEventListener('resize', fitPanel);

    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener('resize', fitPanel);
      window.visualViewport?.removeEventListener('resize', fitPanel);
    };
  }, [gameState]);

  const runMusicAnalysis = useCallback(({
    songUrl,
    audioFile,
    title,
    artist,
    allowFallback,
    storage,
  }) => {
    analysisAbortRef.current?.abort();
    const controller = new AbortController();
    analysisAbortRef.current = controller;
    setAudioError(null);
    setAnalysisState({ phase: 'loading', message: `${title} 분석을 준비하고 있습니다…` });

    return analyzeMusicTrack({
      songUrl,
      audioFile,
      title,
      artist,
      storage,
      signal: controller.signal,
      onStatus: phase => {
        if (ANALYSIS_MESSAGES[phase]) {
          setAnalysisState({ phase: 'loading', message: ANALYSIS_MESSAGES[phase] });
        }
      },
    }).then(analyzedBeatmap => {
      if (controller.signal.aborted) return;
      setBeatmap(analyzedBeatmap);
      setAnalysisState({
        phase: 'ready',
        message: `${analyzedBeatmap.title} · ${Math.round(analyzedBeatmap.bpm)} BPM · 노트 ${analyzedBeatmap.notes.length}개`,
      });
    }).catch(error => {
      if (error.name === 'AbortError') return;
      console.error('Essentia.js analysis failed:', error);
      if (allowFallback) {
        setBeatmap(DEFAULT_BEATMAP);
        setAnalysisState({
          phase: 'fallback',
          message: '자동 분석에 실패해 검증된 기본 비트맵을 사용합니다.',
        });
        return;
      }
      setAnalysisState({
        phase: 'error',
        message: `${title}에서 안정적인 박자를 찾지 못했습니다. 다른 음악을 선택해 주세요.`,
      });
    });
  }, []);

  useEffect(() => {
    void runMusicAnalysis({
      songUrl: DEFAULT_BEATMAP.songUrl,
      title: DEFAULT_BEATMAP.title,
      artist: DEFAULT_BEATMAP.artist,
      allowFallback: true,
    });

    return () => {
      analysisAbortRef.current?.abort();
      if (customSongUrlRef.current) URL.revokeObjectURL(customSongUrlRef.current);
    };
  }, [runMusicAnalysis]);

  useEffect(() => {
    // Connect to backend
    socketRef.current = io(BACKEND_URL, { transports: ['websocket'] });
    const socket = socketRef.current;

    socket.on('connect', () => {
      socket.emit('create_room');
    });

    socket.on('room_created', (id) => {
      if (shouldResetHostRoomState(roomIdRef.current)) {
        closeAllOrientationPeers();
        stopMusic();
        scoresRef.current = {};
        playerOrientations.current = {};
        playerOrientationSequences.current = {};
        playerOrientationReceptions.current = {};
        setPlayers({});
        setScores({});
        setPlayerCalibrationState({});
        setDebugData({});
        setFinalResults([]);
        setGameState('waiting');
      }
      replacingRoomRef.current = false;
      roomIdRef.current = id;
      setRoomId(id);
    });

    socket.on('player_joined', ({ playerId, color }) => {
      setPlayers(prev => ({
        ...prev,
        [playerId]: { id: playerId, color }
      }));
      setScores(prev => {
        const next = { ...prev, [playerId]: 0 };
        scoresRef.current = next;
        return next;
      });
      // Keep the last sequence if the same socket replaces only its WebRTC peer.
      initializeTrackedOrientation(
        playerOrientations.current,
        playerOrientationSequences.current,
        playerId,
        { alpha: 0, beta: 0, gamma: 0 }
      );
      setPlayerCalibrationState(prev => (
        setPlayerCalibration(prev, playerId, CALIBRATION_ALIGNING)
      ));

      const previousPeer = orientationPeersRef.current.get(playerId);
      previousPeer?.close();
      orientationPeersRef.current.delete(playerId);

      if (globalThis.RTCPeerConnection) {
        try {
          const peerSession = createHostOrientationPeer({
            socket,
            roomId: roomIdRef.current,
            playerId,
            onOrientation: (data, sequence) => applyPlayerOrientation(
              playerId,
              data,
              sequence,
              ORIENTATION_TRANSPORT_DIRECT
            ),
          });
          orientationPeersRef.current.set(playerId, peerSession);
          void peerSession.start().catch(error => {
            console.warn('WebRTC orientation offer failed; using Socket.IO fallback.', error);
            if (orientationPeersRef.current.get(playerId) === peerSession) {
              peerSession.close();
              orientationPeersRef.current.delete(playerId);
            }
          });
        } catch (error) {
          console.warn('WebRTC orientation setup failed; using Socket.IO fallback.', error);
        }
      }
    });

    socket.on('player_left', ({ playerId }) => {
      setPlayers(prev => {
        const newPlayers = { ...prev };
        delete newPlayers[playerId];
        return newPlayers;
      });
      setScores(prev => {
        const next = { ...prev };
        delete next[playerId];
        scoresRef.current = next;
        return next;
      });
      delete playerOrientations.current[playerId];
      delete playerOrientationSequences.current[playerId];
      delete playerOrientationReceptions.current[playerId];
      orientationPeersRef.current.get(playerId)?.close();
      orientationPeersRef.current.delete(playerId);
      setPlayerCalibrationState(prev => removePlayerCalibration(prev, playerId));
    });

    socket.on('player_calibration_started', ({ playerId }) => {
      setPlayerCalibrationState(prev => (
        setPlayerCalibration(prev, playerId, CALIBRATION_ALIGNING)
      ));
    });

    socket.on('player_calibration_completed', ({ playerId }) => {
      setPlayerCalibrationState(prev => (
        setPlayerCalibration(prev, playerId, CALIBRATION_READY)
      ));
    });

    socket.on('webrtc_answer', ({ playerId, answer }) => {
      const peerSession = orientationPeersRef.current.get(playerId);
      if (!peerSession) return;
      void peerSession.acceptAnswer(answer).catch(error => {
        console.warn('Could not apply controller WebRTC answer.', error);
        if (orientationPeersRef.current.get(playerId) === peerSession) {
          peerSession.close();
          orientationPeersRef.current.delete(playerId);
        }
      });
    });

    socket.on('webrtc_controller_candidate', ({ playerId, candidate }) => {
      const peerSession = orientationPeersRef.current.get(playerId);
      if (!peerSession) return;
      void peerSession.addCandidate(candidate).catch(error => {
        console.warn('Could not add controller WebRTC candidate.', error);
      });
    });

    socket.on('player_orientation', ({ playerId, data, sequence }) => {
      const peerSession = orientationPeersRef.current.get(playerId);
      if (!shouldAcceptRelayedOrientation(peerSession)) return;
      applyPlayerOrientation(
        playerId,
        data,
        sequence,
        ORIENTATION_TRANSPORT_FALLBACK
      );
    });

    return () => {
      stopMusic();
      closeAllOrientationPeers();
      socket.disconnect();
    };
  }, [applyPlayerOrientation, closeAllOrientationPeers]);

  useEffect(() => {
    if (gameState !== 'finished') return undefined;

    const startedAt = Date.now();
    setResultSecondsLeft(Math.ceil(GAME_RESULT_DURATION_MS / 1000));
    const countdown = window.setInterval(() => {
      const elapsed = Date.now() - startedAt;
      setResultSecondsLeft(Math.max(
        0,
        Math.ceil((GAME_RESULT_DURATION_MS - elapsed) / 1000)
      ));
    }, 250);

    const replaceRoom = window.setTimeout(() => {
      const finishedRoomId = roomIdRef.current;
      closeAllOrientationPeers();
      roomIdRef.current = null;
      scoresRef.current = {};
      playerOrientations.current = {};
      playerOrientationSequences.current = {};
      playerOrientationReceptions.current = {};
      setRoomId(null);
      setPlayers({});
      setScores({});
      setPlayerCalibrationState({});
      setDebugData({});
      setFinalResults([]);
      setGameState('waiting');
      socketRef.current?.emit('replace_room', { roomId: finishedRoomId });
    }, GAME_RESULT_DURATION_MS);

    return () => {
      window.clearInterval(countdown);
      window.clearTimeout(replaceRoom);
    };
  }, [closeAllOrientationPeers, gameState]);

  const calibrationSummary = getCalibrationSummary(players, playerCalibration);
  const pendingPlayer = Object.values(players).find(
    player => playerCalibration[player.id] !== CALIBRATION_READY
  );
  const analysisReady = analysisState.phase === 'ready' || analysisState.phase === 'fallback';

  const releaseCustomSongUrl = () => {
    if (!customSongUrlRef.current) return;
    URL.revokeObjectURL(customSongUrlRef.current);
    customSongUrlRef.current = null;
  };

  const handleMusicFileChange = event => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;

    stopMusic();
    releaseCustomSongUrl();
    const songUrl = URL.createObjectURL(file);
    customSongUrlRef.current = songUrl;
    const title = file.name.replace(/\.[^.]+$/, '') || '내 음악';
    setSelectedTrackName(file.name);
    void runMusicAnalysis({
      songUrl,
      audioFile: file,
      title,
      artist: '내 음악',
      allowFallback: false,
      storage: null,
    });
  };

  const useDefaultMusic = () => {
    stopMusic();
    releaseCustomSongUrl();
    setSelectedTrackName(DEFAULT_BEATMAP.title);
    void runMusicAnalysis({
      songUrl: DEFAULT_BEATMAP.songUrl,
      title: DEFAULT_BEATMAP.title,
      artist: DEFAULT_BEATMAP.artist,
      allowFallback: true,
    });
  };

  useEffect(() => {
    if (gameState !== 'playing') return;
    if (calibrationSummary.showGuide) {
      pauseMusic();
      return;
    }
    void resumeMusic().catch(error => {
      console.error('Could not resume music after calibration:', error);
    });
  }, [calibrationSummary.showGuide, gameState]);

  const finishGame = useCallback(() => {
    if (replacingRoomRef.current) return;
    replacingRoomRef.current = true;
    stopMusic();
    setFinalResults(Object.values(players).map((player, index) => ({
      id: player.id,
      color: player.color,
      label: `P${index + 1}`,
      score: scoresRef.current[player.id] ?? 0,
    })));
    setGameState('finished');
  }, [players]);
  finishGameRef.current = finishGame;

  const startGame = useCallback(() => {
    if (!calibrationSummary.allReady || !analysisReady) return;
    const playerIds = Object.keys(players);
    const resetScores = Object.fromEntries(playerIds.map(playerId => [playerId, 0]));
    replacingRoomRef.current = false;
    scoresRef.current = resetScores;
    setScores(resetScores);
    setFinalResults([]);
    setAudioError(null);
    void startMusic(beatmap.songUrl, () => finishGameRef.current()).catch(error => {
      console.error('Could not start analyzed music:', error);
      stopMusic();
      replacingRoomRef.current = false;
      setAudioError('음악을 재생하지 못했습니다. 브라우저 오디오 권한을 확인한 뒤 다시 시작해 주세요.');
      setGameState('waiting');
    });
    setGameState('playing');
  }, [analysisReady, beatmap.songUrl, calibrationSummary.allReady, players]);

  const autoStartEligible = isAutoStartEligible({
    gameState,
    totalPlayers: calibrationSummary.total,
    allPlayersReady: calibrationSummary.allReady,
    analysisReady,
    blocked: Boolean(audioError),
  });

  useEffect(() => {
    if (!autoStartEligible) {
      setAutoStartSecondsLeft(null);
      return undefined;
    }

    return scheduleAutoStart({
      onTick: setAutoStartSecondsLeft,
      onStart: startGame,
    });
  }, [autoStartEligible, startGame]);

  const handleHit = useCallback((playerId, soundProfile) => {
    playHit(soundProfile);
    socketRef.current?.emit('player_hit', {
      roomId: roomIdRef.current,
      playerId,
    });
    // Score UI is intentionally separate from players so a hit never invalidates
    // or reconciles the 3D game tree.
    const nextScores = incrementScore(scoresRef.current, playerId);
    scoresRef.current = nextScores;
    startTransition(() => setScores(nextScores));
  }, []);

  const handleMiss = useCallback(() => {
    setGameState(getGameStateAfterMiss());
  }, []);

  const joinUrl = `${window.location.protocol}//${window.location.host}/join?roomId=${roomId}`;

  return (
    <div className="app-container">
      {gameState === 'waiting' && (
        <div ref={viewportFitPanelRef} className="glass-panel">
          <h1 className="title">웹 셰이크 쇼다운</h1>
          <p className="subtitle">휴대폰으로 QR 코드를 스캔하세요</p>
          <div style={{ display: 'grid', gap: '10px', justifyItems: 'center', margin: '18px 0' }}>
            <label
              className="btn"
              style={{ display: 'inline-block', padding: '12px 18px', cursor: 'pointer' }}
            >
              내 음악 파일 선택
              <input
                type="file"
                accept="audio/*,.mp3,.wav,.flac,.ogg,.m4a,.aac"
                onChange={handleMusicFileChange}
                style={{
                  position: 'absolute',
                  width: '1px',
                  height: '1px',
                  overflow: 'hidden',
                  clip: 'rect(0, 0, 0, 0)',
                }}
              />
            </label>
            <span style={{ color: '#fff', opacity: 0.78, fontSize: '0.82rem' }}>
              선택한 음악: {selectedTrackName}
            </span>
            {selectedTrackName !== DEFAULT_BEATMAP.title && (
              <button type="button" onClick={useDefaultMusic} style={{ padding: '7px 12px' }}>
                기본 음악으로 돌아가기
              </button>
            )}
          </div>
          <p
            role="status"
            style={{
              color: analysisState.phase === 'error'
                ? '#ff5577'
                : analysisState.phase === 'fallback'
                  ? '#ffcc55'
                  : '#00f3ff',
            }}
          >
            {analysisState.message}
          </p>
          {audioError && (
            <p role="alert" style={{ color: '#ff5577', maxWidth: '32rem' }}>
              {audioError}
            </p>
          )}

          {roomId ? (
            <>
              <div className="qr-container">
                <QRCodeSVG value={joinUrl} size={256} />
              </div>
              <div className="room-id">{roomId}</div>

              <div className="players-list">
                <h3>연결된 플레이어: {Object.keys(players).length}명</h3>
                <div style={{ display: 'flex', gap: '10px', marginTop: '10px' }}>
                  {Object.values(players).map((p, index) => (
                    <div key={p.id} style={{ display: 'grid', justifyItems: 'center', gap: '6px' }}>
                      <div style={{ width: '40px', height: '40px', borderRadius: '50%', backgroundColor: p.color, boxShadow: `0 0 10px ${p.color}` }} />
                      <span style={{ color: p.color, fontSize: '0.78rem', fontWeight: 800 }}>
                        {index + 1}번 · {playerCalibration[p.id] === CALIBRATION_READY ? '위치 맞춤 완료' : '위치 맞추는 중'}
                      </span>
                      <OrientationTransportStatus
                        playerId={p.id}
                        receptions={playerOrientationReceptions.current}
                      />
                    </div>
                  ))}
                </div>
              </div>

              <button
                className="btn"
                onClick={audioError ? startGame : undefined}
                disabled={!audioError || !calibrationSummary.allReady || !analysisReady}
                style={{ opacity: calibrationSummary.allReady && analysisReady ? 1 : 0.5 }}
              >
                {audioError
                  ? '오디오 권한 허용하고 게임 시작'
                  : !analysisReady
                  ? analysisState.phase === 'error'
                    ? '다른 음악 파일을 선택해 주세요'
                    : '음악 자동 분석 중'
                  : calibrationSummary.total === 0
                  ? '휴대폰 연결 대기 중'
                  : calibrationSummary.allReady
                    ? `${autoStartSecondsLeft ?? 5}초 후 자동 시작`
                    : '휴대폰 위치 맞추는 중'}
              </button>
            </>
          ) : (
            <p>게임 방을 만드는 중...</p>
          )}
        </div>
      )}

      {gameState === 'finished' && (
        <div ref={viewportFitPanelRef} className="glass-panel" style={{ minWidth: 'min(520px, 88vw)', textAlign: 'center' }}>
          <h1 className="title" style={{ color: '#ff2d78', textShadow: '0 0 22px #ff0055' }}>
            게임 종료
          </h1>
          <p className="subtitle" style={{ letterSpacing: '0.28rem' }}>최종 점수</p>

          <div style={{ display: 'grid', gap: '18px', margin: '32px 0' }}>
            {finalResults.map(result => (
              <div
                key={result.id}
                style={{
                  padding: '18px 28px',
                  border: `1px solid ${result.color}`,
                  borderRadius: '14px',
                  background: 'rgba(0, 0, 0, 0.38)',
                  boxShadow: `0 0 18px ${result.color}55`,
                }}
              >
                <div style={{ color: result.color, fontSize: '1.2rem', fontWeight: 800 }}>
                  {result.label.replace('P', '플레이어 ')}
                </div>
                <div
                  style={{
                    color: result.color,
                    fontSize: '4rem',
                    fontWeight: 900,
                    lineHeight: 1.05,
                    textShadow: `0 0 18px ${result.color}`,
                  }}
                >
                  {result.score}
                </div>
              </div>
            ))}
          </div>

          <p className="subtitle" style={{ marginBottom: 0 }}>
            {resultSecondsLeft}초 후 새 QR 코드로 이동합니다
          </p>
        </div>
      )}

      {gameState === 'playing' && (
        <>
          <div className="overlay">
            <div style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: '10px' }}>
              {Object.values(players).map(p => (
                <div key={p.id} style={{ display: 'flex', flexDirection: 'column' }}>
                  <div className="score-display" style={{ color: p.color }}>
                    {Object.keys(players).indexOf(p.id) + 1}번: {scores[p.id] ?? 0}점
                  </div>
                  <OrientationTransportStatus
                    playerId={p.id}
                    receptions={playerOrientationReceptions.current}
                  />
                  {debugData[p.id] && (
                    <div style={{ color: 'rgba(255,255,255,0.7)', fontSize: '12px', background: 'rgba(0,0,0,0.5)', padding: '5px', borderRadius: '5px' }}>
                      α: {debugData[p.id].alpha?.toFixed(0)}°<br/>
                      β: {debugData[p.id].beta?.toFixed(0)}°<br/>
                      γ: {debugData[p.id].gamma?.toFixed(0)}°
                    </div>
                  )}
                </div>
              ))}
            </div>
            {/* Could add a timer or combo counter here */}
          </div>
          <GameScene
            players={players}
            playerOrientations={playerOrientations}
            onHit={handleHit}
            onMiss={handleMiss}
            beatmap={beatmap}
            paused={calibrationSummary.showGuide}
          />
        </>
      )}

      {gameState !== 'finished' && calibrationSummary.showGuide && (
        <AlignmentGuide
          mode="host"
          color={pendingPlayer?.color ?? '#00f3ff'}
          pendingCount={calibrationSummary.pending}
        />
      )}
    </div>
  );
};

export default HostView;
