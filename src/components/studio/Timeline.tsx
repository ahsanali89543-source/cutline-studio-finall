import { Button } from "@/components/ui/button";
import { downloadBlob, safeName } from "@/lib/captions/io";
import { loadMediaFile } from "@/lib/captions/load-media";
import { mediaBridge, seekTo } from "@/lib/captions/media";
import { extractAudio } from "@/lib/captions/media-engine";
import { segmentsOf, useStudio } from "@/lib/captions/store";
import { formatTime, projectSpan, round } from "@/lib/captions/timing";
import type { Word } from "@/lib/captions/types";
import {
  AudioLines,
  Eraser,
  Film,
  Magnet,
  Minus,
  Music2,
  Plus,
  Redo2,
  Scissors,
  ScanLine,
  Trash2,
  Type,
  Undo2,
} from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

const LABEL_W = 92;
const RULER_H = 28;
const VIDEO_H = 58;
const AUDIO_H = 58;
const LANE_H = 34;
const MIN_PPS = 6;
const MAX_PPS = 480;

const CUE_COLORS = ["from-violet-500/90 to-indigo-500/90", "from-sky-500/90 to-cyan-500/90", "from-fuchsia-500/90 to-pink-500/90"];

export function Timeline() {
  const words = useStudio((state) => state.project.words);
  const mediaDuration = useStudio((state) => state.mediaDuration);
  const peaks = useStudio((state) => state.peaks);
  const peakRate = useStudio((state) => state.peakRate);
  const thumbs = useStudio((state) => state.thumbs);
  const media = useStudio((state) => state.media);
  const splits = useStudio((state) => state.project.splits ?? []);
  const cuts = useStudio((state) => state.project.cuts ?? []);
  const perCue = useStudio((state) => state.project.look.wordsPerCue);
  const selectedIds = useStudio((state) => state.selectedIds);
  const selectedSegment = useStudio((state) => state.selectedSegment);
  const kind = useStudio((state) => state.mediaKind);
  const past = useStudio((state) => state.past.length);
  const future = useStudio((state) => state.future.length);

  const scroller = useRef<HTMLDivElement>(null);
  const waveCanvas = useRef<HTMLCanvasElement>(null);
  const [view, setView] = useState({ left: 0, width: 800 });
  const [pps, setPps] = useState(60);
  const [fitted, setFitted] = useState(false);
  const [snap, setSnap] = useState(true);
  const [editing, setEditing] = useState<string | null>(null);
  const [extracting, setExtracting] = useState<string | null>(null);
  const [dropping, setDropping] = useState(false);

  const duration = projectSpan(words, mediaDuration);
  const contentWidth = Math.max(view.width, duration * pps + 120);
  const lanes = useMemo(() => assignLanes(words), [words]);
  const laneCount = Math.max(1, lanes.reduce((max, lane) => Math.max(max, lane + 1), 1));
  const captionH = Math.max(LANE_H + 12, laneCount * LANE_H + 12);
  const cueIndex = useMemo(() => cueIndexes(words, perCue), [words, perCue]);
  const segments = useMemo(() => segmentsOf(duration, splits, cuts), [duration, splits, cuts]);
  const selected = useMemo(() => new Set(selectedIds), [selectedIds]);

  // Fit the whole clip in view when the duration changes.
  const fitAll = useCallback(() => {
    const node = scroller.current;
    if (!node) return;
    const next = Math.min(MAX_PPS, Math.max(MIN_PPS, (node.clientWidth - 60) / Math.max(1, duration)));
    setPps(next);
    node.scrollLeft = 0;
  }, [duration]);

  useEffect(() => {
    setFitted(false);
  }, [mediaDuration]);

  useEffect(() => {
    if (fitted) return;
    fitAll();
    setFitted(true);
  }, [fitted, fitAll]);

  useLayoutEffect(() => {
    const node = scroller.current;
    if (!node) return;
    const update = () => setView({ left: node.scrollLeft, width: node.clientWidth });
    update();
    node.addEventListener("scroll", update, { passive: true });
    const observer = new ResizeObserver(update);
    observer.observe(node);
    return () => {
      node.removeEventListener("scroll", update);
      observer.disconnect();
    };
  }, []);

  // Zoom with ctrl/cmd + wheel around the pointer; plain wheel scrolls sideways.
  useEffect(() => {
    const node = scroller.current;
    if (!node) return;
    const onWheel = (event: WheelEvent) => {
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
        const rect = node.getBoundingClientRect();
        const anchorX = event.clientX - rect.left;
        const anchorTime = (node.scrollLeft + anchorX) / pps;
        const next = Math.min(MAX_PPS, Math.max(MIN_PPS, pps * Math.exp(-event.deltaY * 0.0022)));
        setPps(next);
        requestAnimationFrame(() => {
          node.scrollLeft = Math.max(0, anchorTime * next - anchorX);
        });
      } else if (Math.abs(event.deltaY) > Math.abs(event.deltaX) && !event.shiftKey) {
        event.preventDefault();
        node.scrollLeft += event.deltaY;
      }
    };
    node.addEventListener("wheel", onWheel, { passive: false });
    return () => node.removeEventListener("wheel", onWheel);
  }, [pps]);

  // Keyboard zoom (+ / -) and split (S).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable)) return;
      if (event.key === "=" || event.key === "+") setPps((value) => Math.min(MAX_PPS, value * 1.25));
      if (event.key === "-" || event.key === "_") setPps((value) => Math.max(MIN_PPS, value / 1.25));
      if (event.key.toLowerCase() === "s" && !event.metaKey && !event.ctrlKey) {
        useStudio.getState().splitAt(nowTime());
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Waveform painted for the visible window only (stays sharp at any zoom).
  useEffect(() => {
    const canvas = waveCanvas.current;
    if (!canvas) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(1, Math.round(view.width * dpr));
    const h = Math.round((AUDIO_H - 10) * dpr);
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, w, h);
    if (!peaks.length) return;
    const gradient = ctx.createLinearGradient(0, 0, 0, h);
    gradient.addColorStop(0, "#22d3ee");
    gradient.addColorStop(0.5, "#8b5cf6");
    gradient.addColorStop(1, "#22d3ee");
    ctx.fillStyle = gradient;
    const barW = Math.max(1, 2 * dpr);
    const stepPx = barW + Math.max(1, dpr);
    for (let px = 0; px < w; px += stepPx) {
      const t = (view.left + px / dpr) / pps;
      const t2 = (view.left + (px + stepPx) / dpr) / pps;
      const a = Math.floor(t * peakRate);
      const b = Math.max(a + 1, Math.floor(t2 * peakRate));
      let peak = 0;
      for (let index = a; index < b && index < peaks.length; index += 1) if (peaks[index] > peak) peak = peaks[index];
      if (a >= peaks.length) break;
      const bar = Math.max(dpr, peak * (h - 4 * dpr));
      ctx.fillRect(px, (h - bar) / 2, barW, bar);
    }
  }, [peaks, peakRate, pps, view]);

  const timeAt = (clientX: number) => {
    const node = scroller.current;
    if (!node) return 0;
    const rect = node.getBoundingClientRect();
    return Math.max(0, Math.min(duration, (clientX - rect.left + node.scrollLeft) / pps));
  };

  const seek = (time: number) => {
    useStudio.getState().setPlayhead(time);
    seekTo(time);
  };

  const scrub = (event: React.PointerEvent) => {
    event.preventDefault();
    seek(timeAt(event.clientX));
    const move = (ev: PointerEvent) => seek(timeAt(ev.clientX));
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const snapPoints = useCallback(
    (exclude: Set<string>) => {
      const points: number[] = [useStudio.getState().playhead, 0];
      for (const word of useStudio.getState().project.words) {
        if (exclude.has(word.id)) continue;
        points.push(word.start, word.end);
      }
      for (const split of splits) points.push(split);
      return points;
    },
    [splits],
  );

  const snapTime = (value: number, points: number[]) => {
    if (!snap) return value;
    const threshold = 7 / pps;
    let best = value;
    let dist = threshold;
    for (const point of points) {
      const delta = Math.abs(point - value);
      if (delta < dist) {
        dist = delta;
        best = point;
      }
    }
    return best;
  };

  function startWordDrag(event: React.PointerEvent, word: Word) {
    if (event.button !== 0) return;
    event.stopPropagation();
    const state = useStudio.getState();
    const additive = event.shiftKey || event.metaKey || event.ctrlKey;
    if (additive) {
      state.select(word.id, true);
      return;
    }
    const mode = (event.target as HTMLElement).dataset.edge ?? "move";
    const group = selected.has(word.id) && selectedIds.length > 1 ? selectedIds : [word.id];
    if (!selected.has(word.id)) state.select(word.id);
    const ripple = event.altKey && mode === "move";
    const all = state.project.words;
    const moving = ripple ? all.filter((item) => item.start >= word.start).map((item) => item.id) : group;
    const origin = event.clientX;
    const startPositions = new Map(all.filter((item) => moving.includes(item.id)).map((item) => [item.id, { start: item.start, end: item.end }]));
    const exclude = new Set(moving);
    const points = snapPoints(exclude);
    let began = false;
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - origin;
      if (!began) {
        if (Math.abs(dx) < 3) return;
        began = true;
        useStudio.getState().beginGesture();
      }
      const delta = dx / pps;
      const base = startPositions.get(word.id);
      if (!base) return;
      if (mode === "start") {
        const start = snapTime(Math.min(base.end - 0.05, Math.max(0, base.start + delta)), points);
        useStudio.getState().placeWord(word.id, { start: round(start) });
      } else if (mode === "end") {
        const end = snapTime(Math.max(base.start + 0.05, base.end + delta), points);
        useStudio.getState().placeWord(word.id, { end: round(end) });
      } else {
        let shift = delta;
        const snappedStart = snapTime(base.start + delta, points);
        if (snappedStart !== base.start + delta) shift = snappedStart - base.start;
        else {
          const snappedEnd = snapTime(base.end + delta, points);
          if (snappedEnd !== base.end + delta) shift = snappedEnd - base.end;
        }
        const minStart = Math.min(...Array.from(startPositions.values()).map((item) => item.start));
        if (minStart + shift < 0) shift = -minStart;
        const patches: Record<string, Partial<Word>> = {};
        for (const [id, pos] of startPositions) patches[id] = { start: round(pos.start + shift), end: round(pos.end + shift) };
        useStudio.getState().placeWords(patches);
      }
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      if (!began) seek(word.start);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  async function extract(format: "m4a" | "wav") {
    const file = mediaBridge.file;
    if (!file) {
      useStudio.getState().setNote("Upload a video first, then extract its audio.");
      return;
    }
    setExtracting(`Extracting ${format.toUpperCase()}… 0%`);
    try {
      const blob = await extractAudio(file, format, (value) => setExtracting(`Extracting ${format.toUpperCase()}… ${Math.round(value * 100)}%`));
      downloadBlob(`${safeName(useStudio.getState().project.name)}-audio.${format}`, blob);
      useStudio.getState().setNote(`Audio extracted (${format.toUpperCase()}, ${(blob.size / 1048576).toFixed(1)} MB) and downloaded.`);
    } catch (error) {
      useStudio.getState().setNote(error instanceof Error ? error.message : "Could not extract audio.");
    } finally {
      setExtracting(null);
    }
  }

  // Visible windows.
  const from = view.left / pps - 2;
  const to = (view.left + view.width) / pps + 2;
  const tick = tickStep(pps);
  const ticks: number[] = [];
  for (let t = Math.max(0, Math.floor(from / tick.minor) * tick.minor); t <= Math.min(duration + tick.major, to); t += tick.minor) {
    ticks.push(round(t));
  }
  const thumbAspect = media && media.width ? media.width / media.height : 16 / 9;
  const tileW = Math.max(28, Math.round((VIDEO_H - 12) * thumbAspect));
  const tiles: { x: number; src: string }[] = [];
  if (thumbs.length) {
    const startTile = Math.max(0, Math.floor(view.left / tileW) - 1);
    const endTile = Math.min(Math.ceil((duration * pps) / tileW), Math.ceil((view.left + view.width) / tileW) + 1);
    for (let index = startTile; index < endTile; index += 1) {
      const x = index * tileW;
      const t = (x + tileW / 2) / pps;
      const thumb = thumbs[Math.min(thumbs.length - 1, Math.max(0, Math.floor((t / duration) * thumbs.length)))];
      if (thumb) tiles.push({ x, src: thumb });
    }
  }
  const totalH = RULER_H + captionH + VIDEO_H + AUDIO_H + 8;
  const zoomValue = Math.log(pps / MIN_PPS) / Math.log(MAX_PPS / MIN_PPS);
  const hasMedia = Boolean(mediaDuration);

  return (
    <section
      className="flex h-full min-h-0 w-full min-w-0 flex-col border-t border-white/5 bg-surface/80"
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes("Files")) {
          event.preventDefault();
          setDropping(true);
        }
      }}
      onDragLeave={() => setDropping(false)}
      onDrop={(event) => {
        event.preventDefault();
        setDropping(false);
        const file = event.dataTransfer.files[0];
        if (file) void loadMediaFile(file);
      }}
    >
      <div className="flex flex-wrap items-center gap-1 border-b border-white/5 px-2 py-1.5">
        <Button tone="ghost" size="xs" title="Undo (Ctrl+Z)" disabled={!past} onClick={() => useStudio.getState().undo()}>
          <Undo2 className="size-4" />
        </Button>
        <Button tone="ghost" size="xs" title="Redo (Ctrl+Shift+Z)" disabled={!future} onClick={() => useStudio.getState().redo()}>
          <Redo2 className="size-4" />
        </Button>
        <span className="mx-1 h-5 w-px bg-white/10" />
        <Button tone="quiet" size="xs" title="Split at playhead (S)" onClick={() => useStudio.getState().splitAt(nowTime())}>
          <Scissors className="size-3.5" /> Split
        </Button>
        <Button
          tone="quiet"
          size="xs"
          title="Delete selected (Del)"
          disabled={!selectedIds.length && !selectedSegment}
          onClick={() => useStudio.getState().removeSelected()}
        >
          <Trash2 className="size-3.5" /> Delete
        </Button>
        <Button
          tone={snap ? "line" : "ghost"}
          size="xs"
          title="Snap to words, splits and playhead"
          onClick={() => setSnap((value) => !value)}
          className={snap ? "border-accent/60 text-fg" : "text-muted"}
        >
          <Magnet className="size-3.5" /> Snap
        </Button>
        {cuts.length || splits.length ? (
          <Button tone="ghost" size="xs" className="text-muted" onClick={() => useStudio.getState().clearEdits()}>
            Reset cuts
          </Button>
        ) : null}
        <span className="mx-1 h-5 w-px bg-white/10" />
        <Button tone="quiet" size="xs" disabled={!hasMedia || Boolean(extracting)} onClick={() => void extract("m4a")} title="Extract the original audio track (M4A/AAC)">
          <Music2 className="size-3.5" /> {extracting ?? "Extract audio"}
        </Button>
        {!extracting ? (
          <Button tone="ghost" size="xs" disabled={!hasMedia} onClick={() => void extract("wav")} title="Extract as uncompressed WAV">
            WAV
          </Button>
        ) : null}
        <span className="mx-1 h-5 w-px bg-white/10" />
        <Button
          tone="quiet"
          size="xs"
          disabled={!words.length}
          title="Clear all captions only (keep video & audio)"
          onClick={() => useStudio.getState().clearCaptions()}
        >
          <Eraser className="size-3.5" /> Clear captions
        </Button>
        <Button
          tone="ghost"
          size="xs"
          disabled={!past}
          title="Undo (Ctrl+Z)"
          onClick={() => useStudio.getState().undo()}
        >
          <Undo2 className="size-3.5" /> Undo
        </Button>
        <Button
          tone="ghost"
          size="xs"
          disabled={!future}
          title="Redo (Ctrl+Shift+Z)"
          onClick={() => useStudio.getState().redo()}
        >
          <Redo2 className="size-3.5" /> Redo
        </Button>
        <div className="ml-auto flex items-center gap-1.5">
          <TimeReadout />
          <Button tone="ghost" size="xs" title="Zoom out (−)" onClick={() => setPps((value) => Math.max(MIN_PPS, value / 1.35))}>
            <Minus className="size-3.5" />
          </Button>
          <input
            aria-label="Timeline zoom"
            type="range"
            min={0}
            max={1}
            step={0.001}
            value={zoomValue}
            onChange={(event) => setPps(MIN_PPS * Math.pow(MAX_PPS / MIN_PPS, Number(event.target.value)))}
            className="w-24 sm:w-32"
          />
          <Button tone="ghost" size="xs" title="Zoom in (+)" onClick={() => setPps((value) => Math.min(MAX_PPS, value * 1.35))}>
            <Plus className="size-3.5" />
          </Button>
          <Button tone="ghost" size="xs" title="Fit whole clip" onClick={fitAll}>
            <ScanLine className="size-3.5" /> Fit
          </Button>
        </div>
      </div>

      <div className="relative flex min-h-0 flex-1 items-start overflow-y-auto">
        <div className="z-10 shrink-0 border-r border-white/5 bg-surface text-[11px] text-muted" style={{ width: LABEL_W }}>
          <div style={{ height: RULER_H }} className="flex items-center px-2 font-mono text-[10px]">
            {Math.round(pps)}px/s
          </div>
          <TrackLabel height={captionH} icon={<Type className="size-3.5" />} label="Captions" sub={`${words.length} words`} />
          <TrackLabel height={VIDEO_H} icon={<Film className="size-3.5" />} label="Video" sub={kind === "audio" ? "audio only" : hasMedia ? clipLabel(segments.filter((s) => !s.removed).length) : "empty"} />
          <TrackLabel height={AUDIO_H} icon={<AudioLines className="size-3.5" />} label="Audio" sub={peaks.length ? "waveform" : hasMedia ? "reading…" : "empty"} />
        </div>
        <div ref={scroller} className="relative min-w-0 flex-1 overflow-x-auto overflow-y-hidden" style={{ height: totalH + 12 }} data-testid="timeline-scroller">
          <div className="relative" style={{ width: contentWidth, height: totalH }}>
            {/* Ruler */}
            <div className="relative z-20 cursor-ew-resize border-b border-white/10 bg-surface-2/95" style={{ height: RULER_H }} onPointerDown={scrub}>
              {ticks.map((t) => {
                const major = Math.abs(t / tick.major - Math.round(t / tick.major)) < 0.001;
                return (
                  <div key={t} className="absolute bottom-0" style={{ left: t * pps }}>
                    <div className={`w-px ${major ? "h-3 bg-white/40" : "h-1.5 bg-white/15"}`} />
                    {major ? <span className="absolute -top-0.5 left-1 font-mono text-[10px] whitespace-nowrap text-muted">{labelTime(t)}</span> : null}
                  </div>
                );
              })}
            </div>

            {/* Captions track */}
            <div className="relative border-b border-white/5" style={{ height: captionH }} onPointerDown={(event) => {
              if (event.target === event.currentTarget) {
                useStudio.getState().select(null);
                scrub(event);
              }
            }}>
              {words.map((word, index) => {
                if (word.end < from || word.start > to) return null;
                const left = word.start * pps;
                const width = Math.max(10, (word.end - word.start) * pps);
                const lane = lanes[index] ?? 0;
                const isSelected = selected.has(word.id);
                const color = CUE_COLORS[(cueIndex[index] ?? 0) % CUE_COLORS.length];
                return (
                  <div
                    key={word.id}
                    data-testid="timeline-word"
                    className={`group absolute flex items-center overflow-hidden rounded-md bg-gradient-to-b text-white shadow-sm select-none ${color} ${
                      isSelected ? "z-10 ring-2 ring-white" : "ring-1 ring-black/30"
                    } ${word.emphasis ? "outline-2 outline-offset-1 outline-amber-400" : ""}`}
                    style={{ left, width, top: 6 + lane * LANE_H, height: LANE_H - 6, cursor: "grab" }}
                    title={`${word.text} · ${word.start.toFixed(2)}s → ${word.end.toFixed(2)}s (drag to move, edges to trim, Alt+drag moves everything after)`}
                    onPointerDown={(event) => startWordDrag(event, word)}
                    onDoubleClick={(event) => {
                      event.stopPropagation();
                      setEditing(word.id);
                    }}
                  >
                    <span data-edge="start" className="absolute inset-y-0 left-0 z-10 w-2 cursor-ew-resize bg-white/0 group-hover:bg-white/30" />
                    {editing === word.id ? (
                      <input
                        autoFocus
                        defaultValue={word.text}
                        className="mx-1 h-6 w-full min-w-0 rounded bg-black/60 px-1 text-xs text-white outline-none"
                        onPointerDown={(event) => event.stopPropagation()}
                        onBlur={(event) => {
                          useStudio.getState().editText(word.id, event.currentTarget.value);
                          setEditing(null);
                        }}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") event.currentTarget.blur();
                          if (event.key === "Escape") setEditing(null);
                          event.stopPropagation();
                        }}
                      />
                    ) : (
                      <span className="pointer-events-none truncate px-2 text-[11px] font-semibold">{word.text}</span>
                    )}
                    <span data-edge="end" className="absolute inset-y-0 right-0 z-10 w-2 cursor-ew-resize bg-white/0 group-hover:bg-white/30" />
                  </div>
                );
              })}
              {!words.length ? (
                <p className="pointer-events-none absolute top-1/2 left-4 -translate-y-1/2 text-xs text-muted">Transcribe, paste a script or import an SRT — words land here.</p>
              ) : null}
            </div>

            {/* Video track */}
            <div className="relative border-b border-white/5" style={{ height: VIDEO_H }} onPointerDown={(event) => {
              if (event.target === event.currentTarget) scrub(event);
            }}>
              {hasMedia ? (
                <>
                  <div className="pointer-events-none absolute top-1.5 overflow-hidden rounded-md bg-black ring-1 ring-white/10" style={{ left: 0, width: duration * pps, height: VIDEO_H - 12 }}>
                    {tiles.map((tile) => (
                      <img key={tile.x} src={tile.src} alt="" className="absolute top-0 h-full object-cover opacity-90" style={{ left: tile.x, width: tileW }} draggable={false} />
                    ))}
                    {!tiles.length ? <div className="h-full w-full bg-[linear-gradient(90deg,#1e1b4b,#0e7490)] opacity-70" /> : null}
                  </div>
                  {segments.map((segment) => {
                    const isSel = selectedSegment && Math.abs(selectedSegment.start - segment.start) < 0.001 && Math.abs(selectedSegment.end - segment.end) < 0.001;
                    return (
                      <button
                        key={`${segment.start}-${segment.end}`}
                        type="button"
                        data-testid={segment.removed ? "segment-removed" : "segment"}
                        className={`absolute top-1.5 rounded-md ${segment.removed ? "hatch ring-1 ring-rose-400/80" : isSel ? "bg-white/10 ring-2 ring-white" : "ring-1 ring-white/0 hover:ring-white/40"}`}
                        style={{ left: segment.start * pps, width: Math.max(4, (segment.end - segment.start) * pps), height: VIDEO_H - 12 }}
                        title={segment.removed ? "Removed — click to restore" : "Click to select, then Delete to cut it out"}
                        onPointerDown={(event) => event.stopPropagation()}
                        onClick={() => {
                          if (segment.removed && segment.cutId) useStudio.getState().restoreCut(segment.cutId);
                          else useStudio.getState().selectSegment({ start: segment.start, end: segment.end });
                        }}
                      >
                        {segment.removed && (segment.end - segment.start) * pps > 70 ? (
                          <span className="rounded bg-black/60 px-1.5 py-0.5 text-[10px] text-rose-200">removed · restore</span>
                        ) : null}
                      </button>
                    );
                  })}
                  {splits.map((split) => (
                    <div key={split} className="pointer-events-none absolute top-0 bottom-0 w-0.5 bg-amber-300" style={{ left: split * pps - 1 }}>
                      <Scissors className="absolute -top-0.5 -left-[7px] size-3.5 text-amber-300" />
                    </div>
                  ))}
                </>
              ) : (
                <p className="pointer-events-none absolute top-1/2 left-4 -translate-y-1/2 text-xs text-muted">Drop a video here or use Upload video.</p>
              )}
            </div>

            {/* Audio track */}
            <div className="relative" style={{ height: AUDIO_H }} onPointerDown={scrub}>
              <div className="pointer-events-none absolute top-1 rounded-md bg-cyan-500/[0.06] ring-1 ring-cyan-400/15" style={{ left: 0, width: hasMedia ? duration * pps : 0, height: AUDIO_H - 10 }} />
              <canvas ref={waveCanvas} className="pointer-events-none absolute top-1" style={{ left: view.left, width: view.width, height: AUDIO_H - 10 }} />
              {cuts.map((cut) => (
                <div key={cut.id} className="hatch pointer-events-none absolute top-1 rounded" style={{ left: cut.start * pps, width: (cut.end - cut.start) * pps, height: AUDIO_H - 10 }} />
              ))}
            </div>

            <PlayheadLine pps={pps} height={totalH} scroller={scroller} />
          </div>
        </div>
        {dropping ? (
          <div className="pointer-events-none absolute inset-0 z-40 grid place-items-center bg-accent/20 text-sm font-semibold ring-2 ring-accent ring-inset">
            Drop to load this file
          </div>
        ) : null}
      </div>
    </section>
  );
}

function PlayheadLine({ pps, height, scroller }: { pps: number; height: number; scroller: React.RefObject<HTMLDivElement | null> }) {
  const playhead = useStudio((state) => state.playhead);
  const playing = useStudio((state) => state.playing);
  // Keep the playhead on screen while playing.
  useEffect(() => {
    const node = scroller.current;
    if (!node || !playing) return;
    const x = playhead * pps;
    if (x < node.scrollLeft + 30 || x > node.scrollLeft + node.clientWidth - 60) {
      node.scrollLeft = Math.max(0, x - node.clientWidth * 0.25);
    }
  }, [playhead, pps, playing, scroller]);
  return (
    <div className="pointer-events-none absolute top-0 z-30" style={{ left: playhead * pps, height }} data-testid="playhead">
      <div className="absolute top-0 -left-[7px] h-3.5 w-3.5 rotate-45 rounded-sm bg-yellow-300 shadow-[0_0_12px_rgba(253,224,71,0.9)]" />
      <div className="absolute top-2 bottom-0 left-0 w-0.5 -translate-x-1/2 bg-yellow-300 shadow-[0_0_10px_rgba(253,224,71,0.8)]" />
    </div>
  );
}

function TimeReadout() {
  const playhead = useStudio((state) => state.playhead);
  return <span className="hidden font-mono text-xs text-muted tabular-nums sm:inline">{formatTime(playhead)}</span>;
}

function TrackLabel({ height, icon, label, sub }: { height: number; icon: React.ReactNode; label: string; sub: string }) {
  return (
    <div className="flex flex-col justify-center gap-0.5 border-b border-white/5 px-2" style={{ height }}>
      <span className="flex items-center gap-1.5 text-xs font-medium text-fg">
        {icon}
        {label}
      </span>
      <span className="truncate text-[10px]">{sub}</span>
    </div>
  );
}

/** The picture's own clock is the truth (it updates even while a seek is pending). */
function nowTime() {
  const video = mediaBridge.video;
  if (video && mediaBridge.url && Number.isFinite(video.currentTime)) return video.currentTime;
  return useStudio.getState().playhead;
}

function clipLabel(count: number) {
  return `${count} clip${count === 1 ? "" : "s"}`;
}

function tickStep(pps: number) {
  const steps = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
  const major = steps.find((step) => step * pps >= 80) ?? 600;
  const minor = major / (major === 0.25 || major === 15 ? 5 : major >= 1 && [2, 10, 60, 120, 600].includes(major) ? 4 : 5);
  return { major, minor };
}

function labelTime(t: number) {
  const minutes = Math.floor(t / 60 + 1e-6);
  const seconds = Math.max(0, t - minutes * 60);
  const fractional = Math.abs(seconds - Math.round(seconds)) > 0.001;
  const [whole, frac] = seconds.toFixed(fractional ? 2 : 0).split(".");
  return `${minutes}:${whole.padStart(2, "0")}${frac ? `.${frac}` : ""}`;
}

function assignLanes(words: { start: number; end: number }[]) {
  const ends: number[] = [];
  return words.map((word) => {
    const lane = ends.findIndex((end) => word.start >= end - 0.005);
    if (lane < 0) {
      ends.push(word.end);
      return ends.length - 1;
    }
    ends[lane] = word.end;
    return lane;
  });
}

function cueIndexes(words: Word[], perCue: number) {
  const out: number[] = [];
  let cue = 0;
  let count = 0;
  const limit = Math.max(1, Math.round(perCue));
  for (const word of words) {
    out.push(cue);
    count += 1;
    if (count >= limit || word.breakAfter) {
      cue += 1;
      count = 0;
    }
  }
  return out;
}