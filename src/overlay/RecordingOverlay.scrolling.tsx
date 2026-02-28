import { listen } from "@tauri-apps/api/event";
import React, { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  MicrophoneIcon,
  TranscriptionIcon,
  CancelIcon,
} from "../components/icons";
import "./RecordingOverlay.css";
import { commands } from "@/bindings";
import i18n, { syncLanguageFromSettings } from "@/i18n";
import { getLanguageDirection } from "@/lib/utils/rtl";

type OverlayState = "recording" | "transcribing" | "processing";

const ACCENT = "#4DC9FF";

// --- Waveform bar constants ---
const BAR_MIN_HEIGHT = 2;
const CORNER_RADIUS = 1.5;
const SCROLL_SPEED = 24;
const DESIRED_BAR_WIDTH = 4.5;
const DESIRED_GAP_RATIO = 0.7;
const COLOR_CORE = [77, 201, 255] as const;
const COLOR_GLOW = [0, 140, 255] as const;
const COLOR_HOT = [180, 230, 255] as const;

function drawBar(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
) {
  const r = Math.min(CORNER_RADIUS, w / 2, h / 2);
  if (h < 1) return;
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
  ctx.fill();
}

interface WaveformState {
  barCount: number;
  barWidth: number;
  barGap: number;
  amplitudeBuffer: number[];
  barHeights: number[];
  barVelocities: number[];
  scrollAccumulator: number;
}

function createWaveformState(): WaveformState {
  return {
    barCount: 0,
    barWidth: DESIRED_BAR_WIDTH,
    barGap: DESIRED_BAR_WIDTH * DESIRED_GAP_RATIO,
    amplitudeBuffer: [],
    barHeights: [],
    barVelocities: [],
    scrollAccumulator: 0,
  };
}

function resizeWaveform(canvas: HTMLCanvasElement, state: WaveformState) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (w === 0 || h === 0) return;

  canvas.width = w * dpr;
  canvas.height = h * dpr;

  const step = DESIRED_BAR_WIDTH + DESIRED_BAR_WIDTH * DESIRED_GAP_RATIO;
  const newCount = Math.max(
    1,
    Math.floor((w + DESIRED_BAR_WIDTH * DESIRED_GAP_RATIO) / step),
  );

  state.barGap =
    (w - newCount * DESIRED_BAR_WIDTH) / Math.max(1, newCount - 1);
  state.barWidth = DESIRED_BAR_WIDTH;

  if (newCount !== state.barCount) {
    const oldBuffer = state.amplitudeBuffer;
    state.barCount = newCount;
    const bufSize = newCount + 60;
    state.amplitudeBuffer = new Array(bufSize).fill(0);
    for (let i = 0; i < Math.min(oldBuffer.length, bufSize); i++) {
      state.amplitudeBuffer[bufSize - 1 - i] =
        oldBuffer[oldBuffer.length - 1 - i] || 0;
    }
    state.barHeights = new Array(newCount).fill(BAR_MIN_HEIGHT);
    state.barVelocities = new Array(newCount).fill(0);
  }
}

function drawWaveform(
  canvas: HTMLCanvasElement,
  dt: number,
  audioLevel: number,
  state: WaveformState,
) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (w === 0 || h === 0) return;

  // Resize canvas backing store each frame (handles DPR)
  canvas.width = w * dpr;
  canvas.height = h * dpr;

  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const maxBarHeight = h * 0.88;
  const {
    barCount,
    barWidth,
    barGap,
    amplitudeBuffer,
    barHeights,
    barVelocities,
  } = state;

  // Scroll buffer left, push new amplitude samples on the right
  state.scrollAccumulator += SCROLL_SPEED * dt;
  while (state.scrollAccumulator >= 1) {
    amplitudeBuffer.shift();
    const jitter = (Math.random() - 0.5) * 0.15 * audioLevel;
    amplitudeBuffer.push(Math.max(0, Math.min(1, audioLevel + jitter)));
    state.scrollAccumulator -= 1;
  }

  const bufferOffset = amplitudeBuffer.length - barCount;

  // Spring-based smoothing
  for (let i = 0; i < barCount; i++) {
    const raw = amplitudeBuffer[bufferOffset + i];
    // Power curve to expand the low-mid range — quiet speech still fills bars
    const amp = Math.pow(Math.min(1, raw * 2.5), 0.45);
    const target = Math.max(
      BAR_MIN_HEIGHT,
      BAR_MIN_HEIGHT + amp * maxBarHeight * 0.92,
    );
    const stiffness = 45;
    const damping = 8;
    const force = (target - barHeights[i]) * stiffness;
    barVelocities[i] += (force - barVelocities[i] * damping) * dt;
    barHeights[i] += barVelocities[i] * dt;
    barHeights[i] = Math.max(BAR_MIN_HEIGHT, barHeights[i]);
  }

  // Glow layer (soft)
  ctx.save();
  ctx.filter = "blur(6px)";
  for (let i = 0; i < barCount; i++) {
    const x = i * (barWidth + barGap);
    const barH = barHeights[i];
    const y = (h - barH) / 2;
    const intensity = barH / maxBarHeight;
    ctx.fillStyle = `rgba(${COLOR_GLOW[0]}, ${COLOR_GLOW[1]}, ${COLOR_GLOW[2]}, ${0.35 * intensity + 0.05})`;
    drawBar(ctx, x - 1.5, y - 1, barWidth + 3, barH + 2);
  }
  ctx.restore();

  // Medium glow layer
  ctx.save();
  ctx.filter = "blur(2px)";
  for (let i = 0; i < barCount; i++) {
    const x = i * (barWidth + barGap);
    const barH = barHeights[i];
    const y = (h - barH) / 2;
    const intensity = barH / maxBarHeight;
    ctx.fillStyle = `rgba(${COLOR_CORE[0]}, ${COLOR_CORE[1]}, ${COLOR_CORE[2]}, ${0.5 * intensity + 0.1})`;
    drawBar(ctx, x - 0.5, y, barWidth + 1, barH);
  }
  ctx.restore();

  // Sharp bar layer
  for (let i = 0; i < barCount; i++) {
    const x = i * (barWidth + barGap);
    const barH = barHeights[i];
    const y = (h - barH) / 2;
    const intensity = barH / maxBarHeight;

    const r = Math.round(
      COLOR_CORE[0] + (COLOR_HOT[0] - COLOR_CORE[0]) * intensity * 0.6,
    );
    const g = Math.round(
      COLOR_CORE[1] + (COLOR_HOT[1] - COLOR_CORE[1]) * intensity * 0.6,
    );
    const b = Math.round(
      COLOR_CORE[2] + (COLOR_HOT[2] - COLOR_CORE[2]) * intensity * 0.3,
    );

    ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${0.85 + intensity * 0.15})`;
    drawBar(ctx, x, y, barWidth, barH);
  }

  // Hot center highlight on tallest bars
  for (let i = 0; i < barCount; i++) {
    const x = i * (barWidth + barGap);
    const barH = barHeights[i];
    const intensity = barH / maxBarHeight;

    if (intensity > 0.35) {
      const highlightH = barH * 0.4;
      const highlightY = (h - highlightH) / 2;
      ctx.fillStyle = `rgba(${COLOR_HOT[0]}, ${COLOR_HOT[1]}, ${COLOR_HOT[2]}, ${(intensity - 0.35) * 0.5})`;
      drawBar(ctx, x + 0.5, highlightY, barWidth - 1, highlightH);
    }
  }
}

const RecordingOverlay: React.FC = () => {
  const { t } = useTranslation();
  const [isVisible, setIsVisible] = useState(false);
  const [state, setState] = useState<OverlayState>("recording");
  const audioLevelRef = useRef(0);
  const smoothedLevelRef = useRef(0);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animationFrameRef = useRef<number>(0);
  const lastFrameTimeRef = useRef(0);
  const waveformStateRef = useRef<WaveformState>(createWaveformState());
  const direction = getLanguageDirection(i18n.language);

  useEffect(() => {
    const setupEventListeners = async () => {
      const unlistenShow = await listen("show-overlay", async (event) => {
        await syncLanguageFromSettings();
        const overlayState = event.payload as OverlayState;
        setState(overlayState);
        setIsVisible(true);
      });

      const unlistenHide = await listen("hide-overlay", () => {
        setIsVisible(false);
      });

      const unlistenLevel = await listen<number[]>("mic-level", (event) => {
        const newLevels = event.payload as number[];
        const avg =
          newLevels.reduce((sum, v) => sum + v, 0) / (newLevels.length || 1);
        audioLevelRef.current = avg;
      });

      return () => {
        unlistenShow();
        unlistenHide();
        unlistenLevel();
      };
    };

    setupEventListeners();
  }, []);

  useEffect(() => {
    if (state !== "recording") {
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
        animationFrameRef.current = 0;
      }
      return;
    }

    // Reset waveform state when recording starts
    waveformStateRef.current = createWaveformState();
    if (canvasRef.current) {
      resizeWaveform(canvasRef.current, waveformStateRef.current);
    }

    const animate = (timestamp: number) => {
      if (!lastFrameTimeRef.current) lastFrameTimeRef.current = timestamp;
      const delta = Math.min(
        (timestamp - lastFrameTimeRef.current) / 1000,
        0.05,
      );
      lastFrameTimeRef.current = timestamp;

      smoothedLevelRef.current =
        smoothedLevelRef.current * 0.5 + audioLevelRef.current * 0.5;

      if (canvasRef.current) {
        const ws = waveformStateRef.current;
        if (ws.barCount === 0) {
          resizeWaveform(canvasRef.current, ws);
        }
        drawWaveform(
          canvasRef.current,
          delta,
          smoothedLevelRef.current,
          ws,
        );
      }

      animationFrameRef.current = requestAnimationFrame(animate);
    };

    animationFrameRef.current = requestAnimationFrame(animate);

    return () => {
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
        animationFrameRef.current = 0;
      }
      lastFrameTimeRef.current = 0;
    };
  }, [state]);

  const getIcon = () => {
    if (state === "recording") {
      return <MicrophoneIcon color={ACCENT} />;
    } else {
      return <TranscriptionIcon color={ACCENT} />;
    }
  };

  return (
    <div
      dir={direction}
      className={`recording-overlay ${isVisible ? "fade-in" : ""}`}
    >
      <div className="overlay-left">{getIcon()}</div>

      <div className="overlay-middle">
        {state === "recording" && (
          <canvas ref={canvasRef} className="waveform-canvas" />
        )}
        {state === "transcribing" && (
          <div className="transcribing-text">{t("overlay.transcribing")}</div>
        )}
        {state === "processing" && (
          <div className="transcribing-text">{t("overlay.processing")}</div>
        )}
      </div>

      <div className="overlay-right">
        {state === "recording" && (
          <div
            className="cancel-button"
            onClick={() => {
              commands.cancelOperation();
            }}
          >
            <CancelIcon color={ACCENT} />
          </div>
        )}
      </div>
    </div>
  );
};

export default RecordingOverlay;
