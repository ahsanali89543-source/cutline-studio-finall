import { demoProject } from "@/lib/captions/demo";
import { sanitizeWords } from "@/lib/captions/io";
import { templateById, templates } from "@/lib/captions/templates";
import type { Aspect, CaptionLook, Cut, FitMode, Project, VoiceMix, Word } from "@/lib/captions/types";
import { defaultVoice } from "@/lib/captions/types";
import { fitWords, lipSyncWords, projectSpan, round, shiftWords, uid, wordsFromScript } from "@/lib/captions/timing";
import { create } from "zustand";

const STORAGE_KEY = "cutline.projects.v2";
const LEGACY_KEY = "cutline.projects.v1";

type Snap = { words: Word[]; look: CaptionLook; cuts: Cut[]; splits: number[] };

export type MediaMeta = {
  width: number;
  height: number;
  duration: number;
  hasVideo: boolean;
  hasAudio: boolean;
  frameRate: number | null;
};

type StudioState = {
  project: Project;
  library: { id: string; name: string; updatedAt: number }[];
  playhead: number;
  playing: boolean;
  mediaDuration: number | null;
  mediaKind: "video" | "audio" | null;
  media: MediaMeta | null;
  peaks: number[];
  /** Waveform bars per second of audio. */
  peakRate: number;
  thumbs: string[];
  selectedId: string | null;
  selectedIds: string[];
  selectedSegment: { start: number; end: number } | null;
  language: string;
  busy: string | null;
  progress: number | null;
  note: string | null;
  past: Snap[];
  future: Snap[];
  boot: () => void;
  setPlayhead: (time: number) => void;
  setPlaying: (playing: boolean) => void;
  setMedia: (patch: { duration: number | null; kind: "video" | "audio" | null; name: string | null }) => void;
  setMediaMeta: (meta: MediaMeta | null) => void;
  setPeaks: (peaks: number[], rate?: number) => void;
  setThumbs: (thumbs: string[]) => void;
  select: (id: string | null, additive?: boolean) => void;
  selectSegment: (segment: { start: number; end: number } | null) => void;
  setLanguage: (language: string) => void;
  setBusy: (busy: string | null, progress?: number | null) => void;
  setNote: (note: string | null) => void;
  rename: (name: string) => void;
  setAspect: (aspect: Aspect) => void;
  setFit: (fit: FitMode) => void;
  setCaptionMode: (mode: "full" | "key") => void;
  toggleCaptions: () => void;
  toggleGuides: () => void;
  applyLook: (look: CaptionLook) => void;
  patchLook: (patch: Partial<CaptionLook>) => void;
  reviseLook: (patch: Partial<CaptionLook>) => void;
  beginGesture: () => void;
  placeWord: (id: string, patch: Partial<Word>) => void;
  placeWords: (patches: Record<string, Partial<Word>>) => void;
  replaceWords: (words: Word[], speakers?: Record<string, string>) => void;
  clearCaptions: () => void;
  updateWord: (id: string, patch: Partial<Word>) => void;
  editText: (id: string, text: string) => void;
  removeWord: (id: string) => void;
  removeSelected: () => void;
  splitWord: (id: string) => void;
  joinWord: (id: string) => void;
  addWordAt: (time: number, text?: string) => void;
  nudgeAll: (delta: number) => void;
  fitTo: (duration: number) => void;
  layScript: (text: string, duration: number) => void;
  lipSync: () => void;
  autoKeyWords: () => void;
  splitAt: (time: number) => void;
  removeRange: (start: number, end: number) => void;
  restoreCut: (id: string) => void;
  clearEdits: () => void;
  applyGrade: (gradeId: string) => void;
  patchVoice: (patch: Partial<VoiceMix>) => void;
  setSpeakerName: (id: string, name: string) => void;
  undo: () => void;
  redo: () => void;
  newProject: () => void;
  openProject: (id: string) => void;
};

let saveTimer = 0;

function summaries(projects: Project[]) {
  return projects
    .map((project) => ({ id: project.id, name: project.name, updatedAt: project.updatedAt }))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

function readLibrary(): Project[] {
  if (typeof localStorage === "undefined") return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY) ?? localStorage.getItem(LEGACY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as Project[];
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((project) => project && typeof project.id === "string" && Array.isArray(project.words))
      .map(hydrate);
  } catch {
    return [];
  }
}

const lookDefaults = templates.find((item) => item.id === "clean-pop") ?? templates[0];

function hydrate(project: Project): Project {
  const look = { ...lookDefaults, pro: false, ...(project.look ?? {}) } as CaptionLook;
  return {
    ...project,
    look,
    fit: project.fit ?? "blur",
    gradeId: typeof project.gradeId === "string" ? project.gradeId : "neutral",
    voice: { ...defaultVoice, ...(project.voice ?? {}) },
    captionMode: project.captionMode ?? "full",
    splits: Array.isArray(project.splits) ? project.splits : [],
    cuts: Array.isArray(project.cuts) ? project.cuts : [],
  };
}

function writeLibrary(project: Project) {
  if (typeof window === "undefined") return;
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    try {
      const all = readLibrary().filter((item) => item.id !== project.id);
      all.push(project);
      const trimmed = all.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 24);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(trimmed));
      useStudio.setState({ library: summaries(trimmed) });
    } catch {
      /* storage full or blocked — the session still works */
    }
  }, 300);
}

function touch(project: Project, patch: Partial<Project>): Project {
  const next = { ...project, ...patch, updatedAt: Date.now() };
  writeLibrary(next);
  return next;
}

function blank(): Project {
  return {
    id: uid(),
    name: "Untitled reel",
    updatedAt: Date.now(),
    aspect: "original",
    fit: "blur",
    words: [],
    speakers: {},
    look: templateById("roman-classic") ?? templates[0],
    guides: false,
    mediaName: null,
    gradeId: "neutral",
    voice: { ...defaultVoice },
    captionMode: "full",
    splits: [],
    cuts: [],
  };
}

const STOP = new Set(
  "the a an and or to of in on at is are was were be it this that i you we they he she my your our hai hain ka ki ke ko se mein main aur bhi to toh ho tha thi the yeh woh ye wo is us ek na nahi kya jo ab hi par tak liye wala wali wale kar karo raha rahi rahe ga gi ge hum aap tum mera meri mere apna apni apne".split(
    " ",
  ),
);

export const useStudio = create<StudioState>((set, get) => {
  const snapshot = (): Snap => {
    const project = get().project;
    return { words: project.words, look: project.look, cuts: project.cuts ?? [], splits: project.splits ?? [] };
  };
  const commit = (patch: Partial<Pick<Project, "words" | "look" | "cuts" | "splits">>) => {
    const past = [...get().past, snapshot()].slice(-80);
    set({ project: touch(get().project, patch), past, future: [] });
  };

  return {
    project: demoProject(),
    library: [],
    playhead: 0.4,
    playing: false,
    mediaDuration: null,
    mediaKind: null,
    media: null,
    peaks: [],
    peakRate: 40,
    thumbs: [],
    selectedId: null,
    selectedIds: [],
    selectedSegment: null,
    language: "roman-ur",
    busy: null,
    progress: null,
    note: null,
    past: [],
    future: [],
    boot: () => {
      let language = "roman-ur";
      try {
        language = localStorage.getItem("cutline.language") ?? "roman-ur";
      } catch {
        /* ignore */
      }
      const all = readLibrary();
      if (!all.length) {
        const demo = demoProject();
        writeLibrary(demo);
        set({ project: demo, library: summaries([demo]), language });
        return;
      }
      const latest = [...all].sort((a, b) => b.updatedAt - a.updatedAt)[0];
      set({ project: latest, library: summaries(all), language });
    },
    setPlayhead: (time) => set({ playhead: Math.max(0, time) }),
    setPlaying: (playing) => set({ playing }),
    setMedia: ({ duration, kind, name }) => {
      const project = touch(get().project, { mediaName: name });
      set({ project, mediaDuration: duration, mediaKind: kind });
    },
    setMediaMeta: (media) => set({ media }),
    setPeaks: (peaks, rate) => set({ peaks, peakRate: rate ?? get().peakRate }),
    setThumbs: (thumbs) => set({ thumbs }),
    select: (id, additive) => {
      if (!id) {
        set({ selectedId: null, selectedIds: [] });
        return;
      }
      if (additive) {
        const ids = get().selectedIds.includes(id)
          ? get().selectedIds.filter((item) => item !== id)
          : [...get().selectedIds, id];
        set({ selectedId: id, selectedIds: ids, selectedSegment: null });
        return;
      }
      set({ selectedId: id, selectedIds: [id], selectedSegment: null });
    },
    selectSegment: (segment) => set({ selectedSegment: segment, selectedId: null, selectedIds: [] }),
    setLanguage: (language) => {
      try {
        localStorage.setItem("cutline.language", language);
      } catch {
        /* ignore */
      }
      set({ language });
    },
    setBusy: (busy, progress = null) => set({ busy, progress: busy ? progress : null }),
    setNote: (note) => set({ note }),
    rename: (name) => set({ project: touch(get().project, { name }) }),
    setAspect: (aspect) => set({ project: touch(get().project, { aspect }) }),
    setFit: (fit) => set({ project: touch(get().project, { fit }) }),
    setCaptionMode: (captionMode) => set({ project: touch(get().project, { captionMode }) }),
    toggleCaptions: () => set({ project: touch(get().project, { captionsHidden: !get().project.captionsHidden }) }),
    toggleGuides: () => set({ project: touch(get().project, { guides: !get().project.guides }) }),
    applyLook: (look) => commit({ look: { ...look } }),
    patchLook: (patch) => {
      const current = get().project.look;
      commit({ look: { ...current, ...patch, id: current.id.startsWith("custom") ? current.id : `custom-${current.id}`, name: current.name.endsWith("(edited)") ? current.name : `${current.name} (edited)` } });
    },
    reviseLook: (patch) => {
      const current = get().project.look;
      const look = {
        ...current,
        ...patch,
        id: current.id.startsWith("custom") ? current.id : `custom-${current.id}`,
        name: current.name.endsWith("(edited)") ? current.name : `${current.name} (edited)`,
      };
      set({ project: touch(get().project, { look }) });
    },
    beginGesture: () => {
      set({ past: [...get().past, snapshot()].slice(-80), future: [] });
    },
    placeWord: (id, patch) => {
      const words = get().project.words.map((word) => (word.id === id ? { ...word, ...patch } : word));
      set({ project: touch(get().project, { words }) });
    },
    placeWords: (patches) => {
      const words = get()
        .project.words.map((word) => (patches[word.id] ? { ...word, ...patches[word.id] } : word))
        .sort((a, b) => a.start - b.start);
      set({ project: touch(get().project, { words }) });
    },
    replaceWords: (words, speakers) => {
      const named = { ...get().project.speakers };
      if (speakers) Object.assign(named, speakers);
      const past = [...get().past, snapshot()].slice(-80);
      set({
        project: touch(get().project, { words, speakers: named }),
        past,
        future: [],
        selectedId: null,
        selectedIds: [],
        playhead: words[0]?.start ?? 0,
      });
    },
    clearCaptions: () => {
      if (!get().project.words.length) return;
      commit({ words: [] });
      set({ selectedId: null, selectedIds: [] });
    },
    updateWord: (id, patch) => {
      const words = get()
        .project.words.map((word) => (word.id === id ? { ...word, ...patch } : word))
        .sort((a, b) => a.start - b.start);
      commit({ words });
    },
    editText: (id, text) => {
      const cleaned = text.replace(/\s+/g, " ").trim();
      if (!cleaned) {
        get().removeWord(id);
        return;
      }
      get().updateWord(id, { text: cleaned });
    },
    removeWord: (id) => {
      commit({ words: get().project.words.filter((word) => word.id !== id) });
      if (get().selectedId === id) set({ selectedId: null, selectedIds: [] });
    },
    removeSelected: () => {
      const { selectedIds, selectedSegment } = get();
      if (selectedSegment) {
        get().removeRange(selectedSegment.start, selectedSegment.end);
        set({ selectedSegment: null });
        return;
      }
      if (!selectedIds.length) return;
      const drop = new Set(selectedIds);
      commit({ words: get().project.words.filter((word) => !drop.has(word.id)) });
      set({ selectedId: null, selectedIds: [] });
    },
    splitWord: (id) => {
      const words = get().project.words;
      const index = words.findIndex((word) => word.id === id);
      if (index < 0) return;
      const word = words[index];
      const parts = word.text.split(/\s+/).filter(Boolean);
      const mid = Math.max(word.start + 0.04, (word.start + word.end) / 2);
      let left = word.text;
      let right = word.text;
      if (parts.length > 1) {
        const cut = Math.ceil(parts.length / 2);
        left = parts.slice(0, cut).join(" ");
        right = parts.slice(cut).join(" ");
      } else if (word.text.length > 2) {
        const cut = Math.ceil(word.text.length / 2);
        left = word.text.slice(0, cut);
        right = word.text.slice(cut);
      }
      const next = [...words];
      next.splice(index, 1, { ...word, text: left, end: round(mid) }, { ...word, id: uid(), text: right, start: round(mid), emphasis: false });
      commit({ words: next });
    },
    joinWord: (id) => {
      const words = get().project.words;
      const index = words.findIndex((word) => word.id === id);
      if (index < 0 || index === words.length - 1) return;
      const word = words[index];
      const nextWord = words[index + 1];
      const next = [...words];
      next.splice(index, 2, { ...word, text: `${word.text} ${nextWord.text}`.trim(), end: nextWord.end, breakAfter: nextWord.breakAfter });
      commit({ words: next });
    },
    addWordAt: (time, text = "word") => {
      const word: Word = { id: uid(), text, start: round(time), end: round(time + 0.4) };
      commit({ words: [...get().project.words, word].sort((a, b) => a.start - b.start) });
      set({ selectedId: word.id, selectedIds: [word.id] });
    },
    nudgeAll: (delta) => commit({ words: shiftWords(get().project.words, delta) }),
    fitTo: (duration) => commit({ words: fitWords(get().project.words, duration) }),
    layScript: (text, duration) => {
      const words = wordsFromScript(text, duration);
      get().replaceWords(words);
      const span = get().mediaDuration || duration;
      commit({ words: lipSyncWords(get().project.words, get().peaks, span) });
      set({
        note: get().peaks.length
          ? "Script locked to the voice. Drag any word on the timeline that leads or lags the mouth."
          : "Script placed by word weight. Add the video so lip-sync can lock onto speech.",
      });
    },
    lipSync: () => {
      const duration = get().mediaDuration || projectSpan(get().project.words, null);
      commit({ words: lipSyncWords(get().project.words, get().peaks, duration) });
    },
    autoKeyWords: () => {
      const words = get().project.words;
      const scored = words.map((word, index) => {
        const bare = word.text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
        let score = bare.length;
        if (STOP.has(bare)) score -= 10;
        if (/\d/.test(bare)) score += 4;
        if (/[!?]$/.test(word.text)) score += 3;
        if (word.text === word.text.toUpperCase() && bare.length > 2) score += 3;
        return { index, score };
      });
      const target = Math.max(1, Math.round(words.length / 6));
      const keep = new Set(
        [...scored]
          .sort((a, b) => b.score - a.score)
          .slice(0, target)
          .filter((item) => item.score > 3)
          .map((item) => item.index),
      );
      commit({ words: words.map((word, index) => ({ ...word, emphasis: keep.has(index) })) });
    },
    splitAt: (time) => {
      const splits = get().project.splits ?? [];
      const t = round(time);
      if (splits.some((item) => Math.abs(item - t) < 0.05)) return;
      commit({ splits: [...splits, t].sort((a, b) => a - b) });
    },
    removeRange: (start, end) => {
      const a = round(Math.max(0, Math.min(start, end)));
      const b = round(Math.max(a + 0.05, Math.max(start, end)));
      const cuts = [...(get().project.cuts ?? []), { id: uid(), start: a, end: b }];
      commit({ cuts: mergeCuts(cuts) });
    },
    restoreCut: (id) => commit({ cuts: (get().project.cuts ?? []).filter((cut) => cut.id !== id) }),
    clearEdits: () => commit({ cuts: [], splits: [] }),
    applyGrade: (gradeId) => set({ project: touch(get().project, { gradeId }) }),
    patchVoice: (patch) => set({ project: touch(get().project, { voice: { ...get().project.voice, ...patch } }) }),
    setSpeakerName: (id, name) => set({ project: touch(get().project, { speakers: { ...get().project.speakers, [id]: name } }) }),
    undo: () => {
      const { past, future, project } = get();
      const snap = past[past.length - 1];
      if (!snap) return;
      set({
        project: touch(project, snap),
        past: past.slice(0, -1),
        future: [...future, snapshot()],
      });
    },
    redo: () => {
      const { past, future, project } = get();
      const snap = future[future.length - 1];
      if (!snap) return;
      set({
        project: touch(project, snap),
        future: future.slice(0, -1),
        past: [...past, snapshot()],
      });
    },
    newProject: () => {
      const project = blank();
      writeLibrary(project);
      set({
        project,
        library: summaries([project, ...readLibrary()]),
        playhead: 0,
        playing: false,
        mediaDuration: null,
        mediaKind: null,
        media: null,
        peaks: [],
        thumbs: [],
        selectedId: null,
        selectedIds: [],
        selectedSegment: null,
        past: [],
        future: [],
        note: null,
      });
    },
    openProject: (id) => {
      const found = readLibrary().find((project) => project.id === id);
      if (!found) return;
      set({
        project: found,
        playhead: found.words[0]?.start ?? 0,
        playing: false,
        mediaDuration: null,
        mediaKind: null,
        media: null,
        peaks: [],
        thumbs: [],
        selectedId: null,
        selectedIds: [],
        selectedSegment: null,
        past: [],
        future: [],
        note: found.mediaName ? `Re-attach ${found.mediaName} to see the picture again.` : null,
      });
    },
  };
});

function mergeCuts(cuts: Cut[]): Cut[] {
  const sorted = [...cuts].sort((a, b) => a.start - b.start);
  const out: Cut[] = [];
  for (const cut of sorted) {
    const last = out[out.length - 1];
    if (last && cut.start <= last.end + 0.01) last.end = Math.max(last.end, cut.end);
    else out.push({ ...cut });
  }
  return out;
}

/** Segments of the source between split points, flagged when removed. */
export function segmentsOf(duration: number, splits: number[], cuts: Cut[]) {
  const points = [0, ...splits.filter((item) => item > 0.01 && item < duration - 0.01), duration];
  const out: { start: number; end: number; removed: boolean; cutId?: string }[] = [];
  for (let index = 0; index < points.length - 1; index += 1) {
    const start = points[index];
    const end = points[index + 1];
    const mid = (start + end) / 2;
    const cut = cuts.find((item) => mid >= item.start && mid <= item.end);
    out.push({ start, end, removed: Boolean(cut), cutId: cut?.id });
  }
  return out;
}

/** Kept ranges of the source after cuts. */
export function keptRanges(duration: number, cuts: Cut[]): { start: number; end: number }[] {
  const sorted = [...cuts].sort((a, b) => a.start - b.start);
  const out: { start: number; end: number }[] = [];
  let cursor = 0;
  for (const cut of sorted) {
    if (cut.start > cursor + 0.01) out.push({ start: cursor, end: Math.min(cut.start, duration) });
    cursor = Math.max(cursor, cut.end);
  }
  if (cursor < duration - 0.01) out.push({ start: cursor, end: duration });
  return out.filter((range) => range.end - range.start > 0.01);
}

export function applyIncomingWords(raw: unknown[], durationHint?: number) {
  let words = sanitizeWords(raw);
  if (durationHint && words.length) {
    const max = Math.max(...words.map((word) => word.end));
    if (max > durationHint * 8 && max > 30) {
      words = words.map((word) => ({ ...word, start: round(word.start / 1000), end: round(word.end / 1000) }));
    }
  }
  const speakers: Record<string, string> = {};
  for (const word of words) {
    if (word.speaker == null) continue;
    const key = String(word.speaker);
    if (!speakers[key]) speakers[key] = `Speaker ${word.speaker + 1}`;
  }
  useStudio.getState().replaceWords(words, speakers);
}

export function applyTemplateFromSearch(id: string | undefined) {
  const look = templateById(id);
  if (!look) return;
  useStudio.getState().applyLook(look);
}