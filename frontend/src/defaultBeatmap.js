import { NOTE_LEAD_SECONDS } from './toxicBeatmap.js';

export const DEFAULT_SONG_URL = '/audio/Dancing in My Room.mp3';
export const DEFAULT_SONG_DURATION = 180.163628;
export const DEFAULT_SONG_BPM = 120;

const NOTE_INTERVAL_SECONDS = (60 / DEFAULT_SONG_BPM) * 2;
const FIRST_NOTE_TIME = Math.ceil(NOTE_LEAD_SECONDS / NOTE_INTERVAL_SECONDS)
  * NOTE_INTERVAL_SECONDS;
const NOTE_LANES = [-1, 0, 1, 0, -1, 1];
const noteCount = Math.floor(
  (DEFAULT_SONG_DURATION - FIRST_NOTE_TIME) / NOTE_INTERVAL_SECONDS
) + 1;

export const DEFAULT_NOTES = Array.from({ length: noteCount }, (_, index) => ({
  id: `dancing-in-my-room-${index}`,
  time: FIRST_NOTE_TIME + index * NOTE_INTERVAL_SECONDS,
  lane: NOTE_LANES[index % NOTE_LANES.length],
  accent: index % 8 === 0,
}));

export const DEFAULT_SECTIONS = [
  { start: 0, end: 30, name: 'OPENING', level: 1, isRush: false },
  { start: 30, end: 60, name: 'VERSE', level: 2, isRush: false },
  { start: 60, end: 90, name: 'BUILD', level: 3, isRush: false },
  { start: 90, end: 120, name: 'CHORUS', level: 5, isRush: true },
  { start: 120, end: 150, name: 'BREAKDOWN', level: 3, isRush: false },
  { start: 150, end: DEFAULT_SONG_DURATION, name: 'FINAL RUSH', level: 6, isRush: true },
];

export const DEFAULT_BEATMAP = {
  songUrl: DEFAULT_SONG_URL,
  title: 'Dancing in My Room',
  artist: '347aidan',
  duration: DEFAULT_SONG_DURATION,
  bpm: DEFAULT_SONG_BPM,
  confidence: 0,
  notes: DEFAULT_NOTES,
  sections: DEFAULT_SECTIONS,
  analysisSource: '정적 폴백',
};
