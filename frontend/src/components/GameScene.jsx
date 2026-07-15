import React, { useRef, useState } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { Stars } from '@react-three/drei';
import {
  EffectComposer,
  Bloom,
  Vignette,
  ChromaticAberration,
  Scanline,
} from '@react-three/postprocessing';
import { BlendFunction } from 'postprocessing';
import Sword from './Sword';
import HitEffects from './HitEffects';
import { swordHitsObstacle } from '../gameLogic';
import { getMusicTime } from '../audio';
import {
  NOTE_LEAD_SECONDS,
  NOTE_MISS_Z,
  NOTE_SPEED,
  formatSongTime,
  getBeatmapSection,
  getNoteZ,
} from '../toxicBeatmap';

// Schedule analyzed notes against the audio element's absolute playback time so
// slow frames cannot make the map drift away from the music.
const ObstaclesManager = ({
  players,
  playerOrientations,
  onHit,
  onMiss,
  hitEffects,
  beatmap,
  onMapStatusChange,
  paused,
}) => {
  const [obstacles, setObstacles] = useState([]);
  const obstaclesRef = useRef([]);
  const nextNoteIndexRef = useRef(0);
  const lastStatusKeyRef = useRef(null);

  useFrame(() => {
    if (paused) return;
    const songTime = getMusicTime();
    const section = getBeatmapSection(songTime, beatmap.sections);
    const statusKey = `${section.name}:${Math.floor(songTime)}`;
    if (lastStatusKeyRef.current !== statusKey) {
      lastStatusKeyRef.current = statusKey;
      onMapStatusChange?.({ section, songTime });
    }

    let next = obstaclesRef.current;
    const playerArray = Object.values(players);
    const spawned = [];

    while (
      playerArray.length > 0
      && nextNoteIndexRef.current < beatmap.notes.length
      && beatmap.notes[nextNoteIndexRef.current].time - songTime <= NOTE_LEAD_SECONDS
    ) {
      const noteIndex = nextNoteIndexRef.current;
      const note = beatmap.notes[noteIndex];
      const targetIndex = noteIndex % playerArray.length;
      const targetPlayer = playerArray[targetIndex];
      const playerCenter = playerArray.length === 1 ? 0 : (targetIndex === 0 ? -2 : 2);
      const laneSpacing = playerArray.length === 1 ? 2.15 : 1.1;

      spawned.push({
        ...note,
        x: playerCenter + note.lane * laneSpacing,
        y: 0,
        z: getNoteZ(note.time, songTime),
        color: targetPlayer.color,
        targetPlayerId: targetPlayer.id,
        hit: false,
      });
      nextNoteIndexRef.current += 1;
    }
    if (spawned.length > 0) next = [...next, ...spawned];

    // Move obstacles and check collisions. State is driven from a ref instead of a
    // setState updater so this stays free of side effects: under StrictMode the
    // updater runs twice, which previously double-counted every hit.
    const hitEvents = [];
    const missedPlayerIds = [];
    const pArray = Object.values(players);
    next = next.map(obs => {
      let updatedObs = {
        ...obs,
        previousZ: obs.z,
        z: getNoteZ(obs.time, songTime),
      };

      if (!updatedObs.hit) {
        for (let i = 0; i < pArray.length; i++) {
          const p = pArray[i];
          const xPos = pArray.length === 1 ? 0 : (i === 0 ? -2 : 2);
          const orientation = playerOrientations.current[p.id];

          // Use the exact same blade pose as Sword.jsx. This keeps collision aligned
          // with what the player sees, including fast obstacles crossing between frames.
          if (orientation && swordHitsObstacle({
            swordX: xPos,
            orientation,
            obstacle: updatedObs,
          })) {
            updatedObs.hit = true;
            hitEvents.push({
              playerId: p.id,
              soundProfile: updatedObs.soundProfile,
            });
            hitEffects.current?.spawn({
              x: updatedObs.x,
              y: updatedObs.y,
              z: updatedObs.z,
              color: updatedObs.color,
            });
            break;
          }
        }
      }
      return updatedObs;
    }).filter(obs => {
      if (obs.hit) return false;
      if (obs.z >= NOTE_MISS_Z) {
        if (obs.targetPlayerId) missedPlayerIds.push(obs.targetPlayerId);
        return false;
      }
      return true;
    });

    obstaclesRef.current = next;
    setObstacles(next);

    if (onHit) {
      for (const hit of hitEvents) onHit(hit.playerId, hit.soundProfile);
    }
    if (onMiss) {
      for (const id of missedPlayerIds) onMiss(id);
    }
  });

  return (
    <group>
      {obstacles.map(obs => (
        <mesh
          key={obs.id}
          position={[obs.x, obs.y, obs.z]}
          rotation={[obs.z * 0.1, obs.z * 0.1, obs.accent ? Math.PI / 4 : 0]}
          scale={obs.accent ? 1.24 : 1}
        >
          <boxGeometry args={[1, 1, 1]} />
          <meshStandardMaterial
            color={obs.color}
            emissive={obs.color}
            emissiveIntensity={2.5}
            wireframe={true}
            toneMapped={false}
          />
        </mesh>
      ))}
    </group>
  );
};

// Animated Synthwave Grid Ground
const MovingGrid = ({ color, y, speed, paused }) => {
  const gridRef = useRef();

  useFrame((state, delta) => {
    if (paused) return;
    // move the grid towards the camera to simulate forward motion
    if (gridRef.current) {
      gridRef.current.position.z = (gridRef.current.position.z + speed * delta) % 10;
    }
  });

  return (
    <mesh ref={gridRef} rotation={[-Math.PI / 2, 0, 0]} position={[0, y, 0]}>
      <planeGeometry args={[200, 200, 60, 60]} />
      <meshBasicMaterial color={color} wireframe transparent opacity={0.35} toneMapped={false} />
    </mesh>
  );
};

const GameScene = ({ players, playerOrientations, onHit, onMiss, beatmap, paused = false }) => {
  const playersArray = Object.values(players);
  const hitEffectsRef = useRef();
  const [mapStatus, setMapStatus] = useState(() => ({
    section: getBeatmapSection(0, beatmap.sections),
    songTime: 0,
  }));
  const { section, songTime } = mapStatus;

  return (
    <div className="canvas-container">
      <div
        aria-label={`${beatmap.title} ${section.name}, 난이도 ${section.level}단계${section.isRush ? ', 폭주 진행 중' : ''}`}
        style={{
          position: 'absolute',
          top: '1.25rem',
          left: '50%',
          transform: 'translateX(-50%)',
          zIndex: 20,
          pointerEvents: 'none',
          textAlign: 'center',
          fontFamily: 'Orbitron, sans-serif',
          fontWeight: 900,
          letterSpacing: '0.18em',
          color: section.isRush ? '#ffdd00' : '#00f3ff',
          textShadow: section.isRush
            ? '0 0 8px #ff0055, 0 0 24px #ffdd00'
            : '0 0 14px #00f3ff',
        }}
      >
        <div style={{ fontSize: '1rem', opacity: 0.9 }}>
          {beatmap.title} · {section.name} · {section.level}단계
        </div>
        <div style={{ marginTop: '0.3rem', fontSize: '0.72rem', color: '#fff', opacity: 0.76 }}>
          {beatmap.artist} · {formatSongTime(songTime, beatmap.duration)} / {formatSongTime(beatmap.duration, beatmap.duration)} · {Math.round(beatmap.bpm)} BPM
        </div>
        {section.isRush && (
          <div style={{ marginTop: '0.2rem', fontSize: '2rem', color: '#ffdd00' }}>
            폭주!
          </div>
        )}
      </div>
      <Canvas camera={{ position: [0, 2, 8], fov: 60 }} dpr={[1, 2]}>
        <color attach="background" args={['#0a0018']} />
        {/* Synthwave foggy atmosphere */}
        <fog attach="fog" args={['#1a0033', 12, 65]} />

        <ambientLight intensity={0.25} />
        <directionalLight position={[0, 10, -10]} intensity={1.8} color="#00f3ff" />
        <pointLight position={[0, 2, 5]} intensity={2.5} color="#ff007f" />
        <pointLight position={[0, 8, -60]} intensity={4} color="#ff2d95" distance={120} />

        <Stars
          radius={120}
          depth={60}
          count={5000}
          factor={5}
          saturation={1}
          fade
          speed={section.isRush ? 3 : 1.5}
        />

        {/* Floor grid plus a faint mirrored ceiling grid for a tunnel feel */}
        <MovingGrid color="#ff007f" y={-2} speed={NOTE_SPEED * (section.isRush ? 1.08 : 1)} paused={paused} />
        <MovingGrid color="#00f3ff" y={8} speed={NOTE_SPEED * (section.isRush ? 1.08 : 1)} paused={paused} />

        <ObstaclesManager
          players={players}
          playerOrientations={playerOrientations}
          onHit={onHit}
          onMiss={onMiss}
          hitEffects={hitEffectsRef}
          beatmap={beatmap}
          onMapStatusChange={setMapStatus}
          paused={paused}
        />

        <HitEffects ref={hitEffectsRef} />

        {playersArray.map((player, index) => (
          <Sword
            key={player.id}
            player={player}
            index={index}
            totalPlayers={playersArray.length}
            playerOrientations={playerOrientations}
          />
        ))}

        {/* Post-Processing stack for the neon synthwave look */}
        <EffectComposer disableNormalPass>
          <Bloom
            luminanceThreshold={0.8}
            mipmapBlur
            intensity={section.isRush ? 3 : 2.4}
            radius={0.85}
          />
          <ChromaticAberration
            blendFunction={BlendFunction.NORMAL}
            offset={section.isRush ? [0.0022, 0.0028] : [0.0009, 0.0012]}
          />
          <Scanline blendFunction={BlendFunction.OVERLAY} density={1.3} opacity={0.12} />
          <Vignette eskil={false} offset={0.25} darkness={0.9} />
        </EffectComposer>
      </Canvas>
    </div>
  );
};

export default React.memo(GameScene);
