// SPDX-License-Identifier: GPL-3.0-or-later
import type { Reaction, ReactionCounts, TargetCounts } from "../shared/reactions";
import animationsCss from "./animations.css?raw";
import { applyEmojiSpriteHost, createEmojiSpriteElement, EMOJI_SPRITE_MODE_ATTR, emojiSpriteCss } from "./emoji-sprite";

export interface ReactionAnimationOrigin {
  x: number;
  y: number;
}

const STYLE_ID = "khasky-emojery-reaction-animations-style";
// Also the sprite scope below, and the `#khasky-emojery-reaction-animations` rule in animations.css.
const LAYER_ID = "khasky-emojery-reaction-animations";
const MAX_INTRO_PARTICLES = 10;
// Intro stagger: each emoji's group starts a beat after the previous one, each particle
// within a group a shorter beat after the last, plus a random spread so the launches
// never line up into a visible rank.
const INTRO_EMOJI_STAGGER_MS = 140;
const INTRO_PARTICLE_STAGGER_MS = 90;
const INTRO_STAGGER_JITTER_MS = 120;
// The top-ranked emoji gets one extra particle so the most-used reaction reads as the
// dominant one; the rest of the budget is split evenly.
const INTRO_PARTICLES_TOP_EMOJI = 4;
const INTRO_PARTICLES_PER_EMOJI = 3;
// Facebook disables CSS animations for descendants that do not carry this
// escape class when its reduced-motion wrapper is active.
const PAGE_ANIMATION_ESCAPE_CLASS = "always-enable-animations";
// Carried by the host only while the drop-in plays; mount-style.ts reads it to skip
// its flank probe (detaching the host would restart the animation). Styled in
// animations.css, which spells the class and its 360ms duration out literally.
export const BUTTON_DROP_CLASS = "khasky-emojery-button-drop";
// When the button hits the ground and the dust puffs: the 55% impact keyframe of
// animations.css's khasky-emojery-button-drop.
const BUTTON_DROP_IMPACT_MS = 200;
const DUST_PARTICLE_COUNT = 7;

let introPlayedForUrl: string | null = null;

// OS-level "reduce motion" suppresses the emoji bursts regardless of the Reaction-animations
// setting (which defaults on, so it isn't an explicit opt-in that should override the OS signal).
function prefersReducedMotion(): boolean {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

// As many as the trigger itself shows, so the intro animates exactly the emoji the user is
// about to see settle into the pill.
const INTRO_EMOJI_COUNT = 3;

function topReactionEmojis(counts: ReactionCounts): Reaction[] {
  return Object.entries(counts)
    .filter(([, count]) => (count ?? 0) > 0)
    .sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))
    .slice(0, INTRO_EMOJI_COUNT)
    .map(([emoji]) => emoji);
}

export function maybePlayPublicReactionIntro(value: TargetCounts): void {
  if (prefersReducedMotion()) return;
  const pageKey = window.location.href;
  if (introPlayedForUrl === pageKey || value.total <= 0) {
    return;
  }
  const emojis = topReactionEmojis(value.counts);
  if (emojis.length === 0) return;
  introPlayedForUrl = pageKey;

  let remaining = MAX_INTRO_PARTICLES;
  emojis.forEach((emoji, emojiIndex) => {
    const count = Math.min(remaining, emojiIndex === 0 ? INTRO_PARTICLES_TOP_EMOJI : INTRO_PARTICLES_PER_EMOJI);
    remaining -= count;
    for (let i = 0; i < count; i += 1) {
      const launchAt = emojiIndex * INTRO_EMOJI_STAGGER_MS + i * INTRO_PARTICLE_STAGGER_MS + Math.random() * INTRO_STAGGER_JITTER_MS;
      window.setTimeout(() => spawnIntroParticle(emoji, emojiIndex), launchAt);
    }
  });
}

export function playReactionClickFloat(emoji: Reaction, origin?: ReactionAnimationOrigin): void {
  if (prefersReducedMotion()) return;
  const layer = ensureAnimationLayer();
  if (!layer) return;

  const el = document.createElement("span");
  el.className = `khasky-emojery-reaction-click-float ${PAGE_ANIMATION_ESCAPE_CLASS}`;
  el.appendChild(createEmojiSpriteElement(emoji));

  const x = origin?.x ?? window.innerWidth / 2;
  const y = origin?.y ?? window.innerHeight / 2;
  const drift = randomBetween(-28, 28);
  const rotation = randomBetween(-10, 10);

  el.style.left = `${x}px`;
  el.style.top = `${y}px`;
  el.style.setProperty("--khasky-emojery-float-x", `${drift}px`);
  el.style.setProperty("--khasky-emojery-float-x-early", `${drift * 0.25}px`);
  el.style.setProperty("--khasky-emojery-float-rot", `${rotation}deg`);
  el.style.setProperty("--khasky-emojery-float-start-rot", `${rotation * -0.35}deg`);
  layer.appendChild(el);
  removeAfterAnimation(el);
}

// Drop-in intro for a freshly injected trigger: CSS keyframes on the host plus dust
// particles in the shared fixed layer (transforms only, no layout cost). Gated twice -
// on the OS reduced-motion preference here, on the reaction-animations setting by callers.
export function playButtonPlacement(host: HTMLElement): void {
  if (prefersReducedMotion()) return;
  if (!host.isConnected) return;
  ensureAnimationStyle();

  host.classList.add(BUTTON_DROP_CLASS, PAGE_ANIMATION_ESCAPE_CLASS);
  host.addEventListener(
    "animationend",
    () => {
      host.classList.remove(BUTTON_DROP_CLASS, PAGE_ANIMATION_ESCAPE_CLASS);
    },
    { once: true },
  );

  window.setTimeout(() => spawnDustCloud(host), BUTTON_DROP_IMPACT_MS);
}

export function resetReactionAnimationStateForTests(): void {
  introPlayedForUrl = null;
  document.getElementById(LAYER_ID)?.remove();
  document.getElementById(STYLE_ID)?.remove();
}

function spawnIntroParticle(emoji: Reaction, emojiIndex: number): void {
  const layer = ensureAnimationLayer();
  if (!layer) return;

  const el = document.createElement("span");
  el.className = `khasky-emojery-reaction-intro-particle ${PAGE_ANIMATION_ESCAPE_CLASS}`;
  el.appendChild(createEmojiSpriteElement(emoji));

  const baseSize = emojiIndex === 0 ? 42 : emojiIndex === 1 ? 34 : 28;
  const size = baseSize + randomBetween(-6, 10);
  const startX = randomBetween(8, 92);
  const startY = randomBetween(82, 98);
  const drift = randomBetween(-90, 90);
  const lift = randomBetween(42, 74);
  const rotation = randomBetween(-22, 22);
  const duration = randomBetween(1000, 1500);

  el.style.left = `${startX}vw`;
  el.style.top = `${startY}vh`;
  el.style.fontSize = `${size}px`;
  el.style.animationDuration = `${duration}ms`;
  el.style.setProperty("--khasky-emojery-intro-x", `${drift}px`);
  el.style.setProperty("--khasky-emojery-intro-y", `-${lift}vh`);
  el.style.setProperty("--khasky-emojery-intro-rot", `${rotation}deg`);
  el.style.setProperty("--khasky-emojery-intro-start-rot", `${rotation * -0.4}deg`);
  layer.appendChild(el);
  removeAfterAnimation(el);
}

function spawnDustCloud(host: HTMLElement): void {
  if (!host.isConnected) return;
  const layer = ensureAnimationLayer();
  if (!layer) return;
  const rect = host.getBoundingClientRect();
  if (rect.width <= 0 && rect.height <= 0) return;

  const centerX = rect.left + rect.width / 2;
  const groundY = rect.bottom - 1;

  for (let i = 0; i < DUST_PARTICLE_COUNT; i += 1) {
    const el = document.createElement("span");
    el.className = `khasky-emojery-button-dust ${PAGE_ANIMATION_ESCAPE_CLASS}`;

    // Biased outward from the landing point, with a small upward billow.
    const side = i / (DUST_PARTICLE_COUNT - 1) - 0.5;
    const driftX = side * randomBetween(26, 46) + randomBetween(-5, 5);
    const driftY = -randomBetween(4, 16);
    const size = randomBetween(7, 14);
    const duration = randomBetween(420, 640);

    el.style.left = `${centerX}px`;
    el.style.top = `${groundY}px`;
    el.style.width = `${size}px`;
    el.style.height = `${size}px`;
    el.style.animationDuration = `${duration}ms`;
    el.style.setProperty("--khasky-emojery-dust-x", `${driftX}px`);
    el.style.setProperty("--khasky-emojery-dust-y", `${driftY}px`);
    el.style.setProperty("--khasky-emojery-dust-scale", `${randomBetween(1.7, 2.8)}`);
    el.style.setProperty("--khasky-emojery-dust-opacity", `${randomBetween(0.3, 0.5)}`);
    layer.appendChild(el);
    removeAfterAnimation(el);
  }
}

function ensureAnimationLayer(): HTMLElement | null {
  if (!document.body) return null;
  ensureAnimationStyle();
  const existing = document.getElementById(LAYER_ID);
  if (existing) {
    applyEmojiSpriteHost(existing);
    return existing;
  }

  const layer = document.createElement("div");
  layer.id = LAYER_ID;
  layer.className = PAGE_ANIMATION_ESCAPE_CLASS;
  layer.setAttribute("aria-hidden", "true");
  document.body.appendChild(layer);
  applyEmojiSpriteHost(layer);
  return layer;
}

function ensureAnimationStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  // The sprite rules are scoped to the layer at runtime (they depend on the layer
  // id and the mode attribute), so they are appended rather than authored in
  // animations.css. They style only .khasky-emojery-emoji* elements, which the
  // stylesheet above never touches, so order between the two does not matter.
  style.textContent = animationsCss + emojiSpriteCss({ base: `#${LAYER_ID}`, sprite: `#${LAYER_ID}[${EMOJI_SPRITE_MODE_ATTR}="sprite"]` });
  document.head.appendChild(style);
}

// Safety GC past the longest particle animation, for the case where
// animationend never fires (the animation cancelled mid-flight).
const ANIMATION_GC_TIMEOUT_MS = 4500;

function removeAfterAnimation(el: HTMLElement): void {
  el.addEventListener("animationend", () => el.remove(), { once: true });
  window.setTimeout(() => el.remove(), ANIMATION_GC_TIMEOUT_MS);
}

function randomBetween(min: number, max: number): number {
  return min + Math.random() * (max - min);
}
