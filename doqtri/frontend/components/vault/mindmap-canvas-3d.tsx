"use client";

import { useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import ForceGraph3D, { type ForceGraphMethods, type NodeObject } from "react-force-graph-3d";
import * as THREE from "three";
import SpriteText from "three-spritetext";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import type { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import {
  useLoadedFont,
  useLookup,
  type MindmapCanvasHandle,
  type MindmapCanvasProps,
} from "@/components/vault/mindmap-canvas";
import { fontFamily, fontWeight } from "@/components/vault/mindmap-fonts";
import {
  focusAlpha,
  linkFocusAlpha,
  linkIsLit,
  useMindmapFocus,
  type FocusState,
} from "@/components/vault/use-mindmap-focus";
import { FocusLockButton, placeLockButton } from "@/components/vault/focus-lock-button";
import {
  canvasToBlob,
  loadWatermarkLogo,
  paintBackdrop,
  paintCaption,
} from "@/components/vault/mindmap-paint";
import {
  displayLabel,
  isHidden,
  isLight,
  mix,
  particlesPerLink,
  type MindmapStyle,
} from "@/lib/mindmap-style";
import {
  revealAlpha,
  ZOOM_REVEAL_MIN_NODES,
  type MapNode,
  type MapNodeKind,
} from "@/lib/mindmap-graph";

type Node3D = NodeObject<MapNode> & { fz?: number };
type Link3D = { source: Node3D | string; target: Node3D | string };
type Instance = ForceGraphMethods<Node3D, Link3D>;

/** How long a touch must last on a node to count as a hold. */
const LONG_PRESS_MS = 450;

/** Label height per kind, in world units, before the text scale. */
const TEXT_HEIGHT: Record<MapNodeKind, number> = {
  root: 9,
  document: 7.5,
  hub: 6.5,
  theme: 6.5,
  concept: 5,
  detail: 4.2,
};

function endpoint(value: Node3D | string): Node3D | null {
  return typeof value === "object" ? value : null;
}

/** The screen-filling backdrop as a texture, painted by the same code as 2D. */
function backdropTexture(style: MindmapStyle): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 1024;
  canvas.height = 1024;
  const ctx = canvas.getContext("2d");
  // The grid and dots are flat-canvas ideas; in 3D they become a floor grid.
  if (ctx) paintBackdrop(ctx, 1024, 1024, { ...style, vignette: style.vignette });
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function starfield(style: MindmapStyle): THREE.Points {
  const count = 1800;
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const tints = [new THREE.Color("#ffffff"), ...style.palette.branches.map((c) => new THREE.Color(c))];
  for (let i = 0; i < count; i++) {
    // Uniform on a thick shell well outside any map.
    const radius = 1200 + Math.random() * 1800;
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);
    positions[i * 3] = radius * Math.sin(phi) * Math.cos(theta);
    positions[i * 3 + 1] = radius * Math.sin(phi) * Math.sin(theta);
    positions[i * 3 + 2] = radius * Math.cos(phi);
    const tint = Math.random() > 0.8 ? tints[1 + (i % (tints.length - 1))] ?? tints[0] : tints[0];
    colors.set([tint.r, tint.g, tint.b], i * 3);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  const material = new THREE.PointsMaterial({ size: 3, vertexColors: true, transparent: true, opacity: 0.9, sizeAttenuation: true });
  return new THREE.Points(geometry, material);
}

/**
 * Pushes the focus state onto the scene: every material of an unrelated node
 * or link fades toward the dimmed opacity. Each material's own opacity is
 * remembered the first time, so lit objects return to exactly what the style
 * gave them.
 */
function applyFocus3D(graphData: { nodes: Node3D[]; links: Link3D[] }, state: FocusState) {
  const fade = (object: THREE.Object3D | undefined, alpha: number) => {
    object?.traverse((child) => {
      const material = (child as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
      for (const m of Array.isArray(material) ? material : material ? [material] : []) {
        m.userData.baseOpacity ??= m.opacity;
        m.transparent = true;
        m.opacity = (m.userData.baseOpacity as number) * alpha;
      }
    });
  };
  for (const node of graphData.nodes as (Node3D & { __threeObj?: THREE.Object3D })[]) {
    fade(node.__threeObj, focusAlpha(state, node.id));
  }
  for (const link of graphData.links as (Link3D & { __lineObj?: THREE.Mesh | THREE.Line })[]) {
    const s = endpoint(link.source);
    const t = endpoint(link.target);
    const line = link.__lineObj;
    if (!s || !t || !line) continue;
    const alpha = linkFocusAlpha(state, s.id, t.id);
    const material = line.material as THREE.Material;
    // three-forcegraph shares one material between every link of a colour, so
    // a link gets its own copy before it is dimmed — or every link of that
    // colour would dim with it.
    if (alpha < 1 && !material.userData.focusOwned) {
      const own = material.clone();
      own.userData = { focusOwned: true, baseOpacity: material.opacity };
      line.material = own;
    }
    if ((line.material as THREE.Material).userData.focusOwned) fade(line, alpha);
  }
}

function disposeObject(object: THREE.Object3D) {
  object.traverse((child) => {
    const mesh = child as THREE.Mesh;
    mesh.geometry?.dispose();
    const material = mesh.material as THREE.Material | THREE.Material[] | undefined;
    if (Array.isArray(material)) material.forEach((m) => m.dispose());
    else material?.dispose();
  });
}

/**
 * The mindmap in three dimensions: the same graph and style, as labels and orbs
 * floating in space, with bloom for the glow and an orbiting camera.
 *
 * Loaded on demand — three.js is several hundred kilobytes, and only someone
 * who flips the 3D switch should pay for it.
 */
export default function MindmapCanvas3D({
  graph,
  onNodeClick,
  isClickable = () => onNodeClick !== undefined,
  emptyMessage = "Nothing to map yet.",
  look,
  editing = false,
  selectedId = null,
  onSelect,
  handleRef,
  onSettled,
  lockedId = null,
  onLockChange,
}: MindmapCanvasProps & { look: MindmapStyle }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const fgRef = useRef<Instance | undefined>(undefined);
  const bloomRef = useRef<UnrealBloomPass | null>(null);
  const framedRef = useRef(false);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [ready, setReady] = useState(false);

  const lookup = useLookup(graph, look);

  /** When and how the latest press started, to tell a touch hold from a tap. */
  const pressRef = useRef<{ at: number; type: string }>({ at: 0, type: "mouse" });
  const loadedFont = useLoadedFont(look.font);

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setSize({ width: Math.floor(width), height: Math.floor(height) });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const graphData = useMemo(
    () => ({
      nodes: graph.nodes.map((node) => ({ ...node })) as Node3D[],
      links: graph.links.map((link) => ({ ...link })) as Link3D[],
    }),
    [graph],
  );

  useEffect(() => {
    framedRef.current = false;
  }, [graphData]);

  const focusOn = look.focus && !editing;
  const focus = useMindmapFocus(graph, focusOn, (state) => applyFocus3D(graphData, state), lockedId);
  const lockButtonRef = useRef<HTMLButtonElement>(null);
  const boxedLabels = look.three.node === "label" && look.shape !== "underline";
  const revealOn = look.zoomReveal && graph.nodes.length >= ZOOM_REVEAL_MIN_NODES;
  const lookRef = useRef(look);
  useEffect(() => {
    lookRef.current = look;
  });

  // The camera can orbit with nothing else changing, so the lock is placed on
  // its own animation loop rather than on graph events.
  useEffect(() => {
    if (!ready) return;
    const byId = new Map(graphData.nodes.map((node) => [node.id, node]));
    const scratch = new THREE.Vector3();
    const right = new THREE.Vector3();
    let frame = 0;

    /**
     * Zoom reveal: a node shows once its label would be readable from where
     * the camera is — its world height over the distance, times the focal
     * length — by the same rule as 2D. A focused branch is always shown.
     * Links and their particles follow their ends.
     */
    const reveal = (fg: Instance, state: FocusState) => {
      const camera = fg.camera() as THREE.PerspectiveCamera;
      const height = fg.renderer().domElement.clientHeight || 1;
      const focal = height / 2 / Math.tan((camera.fov * Math.PI) / 360);
      const style = lookRef.current;
      const shown = new Set<string>();
      for (const node of graphData.nodes as (Node3D & { __threeObj?: THREE.Object3D })[]) {
        const object = node.__threeObj;
        if (!object) continue;
        let visible = true;
        if (revealOn && node.depth > 1 && !(state.set?.has(node.id) && state.t > 0)) {
          const textHeight =
            (TEXT_HEIGHT[node.kind] ?? TEXT_HEIGHT.concept) * style.textScale * (style.overrides[node.id]?.scale ?? 1);
          const distance = camera.position.distanceTo(scratch.set(node.x ?? 0, node.y ?? 0, node.z ?? 0)) || 1;
          visible = revealAlpha((textHeight * focal) / distance, node.depth) >= 0.5;
        }
        if (object.visible !== visible) object.visible = visible;
        if (visible) shown.add(node.id);
      }
      for (const link of graphData.links as (Link3D & {
        __lineObj?: THREE.Object3D;
        __photonsObj?: THREE.Object3D;
      })[]) {
        const s = endpoint(link.source);
        const t = endpoint(link.target);
        if (!s || !t) continue;
        const both = shown.has(s.id) && shown.has(t.id);
        if (link.__lineObj && link.__lineObj.visible !== both) link.__lineObj.visible = both;
        // Particles only run along the lit branch; a dimmed link has none.
        const photons = both && linkIsLit(state, s.id, t.id);
        if (link.__photonsObj && link.__photonsObj.visible !== photons) link.__photonsObj.visible = photons;
      }
    };

    const place = () => {
      const fg = fgRef.current;
      const state = focus.stateRef.current;
      if (fg) reveal(fg, state);
      const node = state.id ? byId.get(state.id) : undefined;
      let at: { x: number; y: number } | null = null;
      const object = (node as (Node3D & { __threeObj?: THREE.Object3D }) | undefined)?.__threeObj;
      if (fg && node && object && state.set && state.t > 0.5) {
        // Beside the label's right edge, wherever the label sits — on the
        // node itself, or above an orb or crystal — however the camera turns.
        let label: THREE.Sprite | null = null;
        object.traverse((child) => {
          if ((child as THREE.Sprite).isSprite) label = child as THREE.Sprite;
        });
        const sprite = label as THREE.Sprite | null;
        const centre = sprite ? sprite.getWorldPosition(scratch) : scratch.set(node.x ?? 0, node.y ?? 0, node.z ?? 0);
        const half = sprite ? sprite.scale.x / 2 : 6;
        right.setFromMatrixColumn(fg.camera().matrixWorld, 0).multiplyScalar(half);
        const point = fg.graph2ScreenCoords(centre.x + right.x, centre.y + right.y, centre.z + right.z);
        // A boxed label can take the badge slightly over its edge; bare text
        // needs a gap or the badge covers the last letter.
        at = { x: point.x + (boxedLabels ? -6 : 4), y: point.y - 12 };
      }
      placeLockButton(lockButtonRef.current, at, state.id !== null && state.id === lockedId);
      frame = requestAnimationFrame(place);
    };
    frame = requestAnimationFrame(place);
    return () => cancelAnimationFrame(frame);
  }, [ready, graphData, lockedId, focus.stateRef, boxedLabels, revealOn]);

  // Frame the map once it has had a moment to spread out, rather than waiting
  // for the engine to stop: the default camera sits far back, and the full
  // cooldown is several seconds of a speck in the middle of the screen.
  useEffect(() => {
    if (!ready) return;
    const timer = setTimeout(() => fgRef.current?.zoomToFit(800, 40), 900);
    return () => clearTimeout(timer);
  }, [ready, graphData, look.three.layout, look.spacing]);

  // The instance only exists once the graph has mounted, a render after us.
  useEffect(() => {
    if (ready || size.width === 0) return;
    const id = requestAnimationFrame(() => {
      if (fgRef.current) setReady(true);
    });
    return () => cancelAnimationFrame(id);
  });

  // Bloom, added once per instance and retuned as the style changes.
  useEffect(() => {
    const fg = fgRef.current;
    if (!ready || !fg) return;
    let bloom = bloomRef.current;
    if (!bloom) {
      bloom = new UnrealBloomPass(new THREE.Vector2(size.width, size.height), 1, 0.45, 0.5);
      fg.postProcessingComposer().addPass(bloom);
      bloomRef.current = bloom;
    }
    bloom.strength = look.three.bloom;
    // Only the brightest things bloom — orbs, crystals, particles — so labels
    // keep their edges. A light background would bloom everywhere, so it gets
    // a stricter threshold still.
    bloom.threshold = isLight(look.palette.background) ? 0.9 : 0.55;
    bloom.enabled = look.three.bloom > 0;
  }, [ready, look.three.bloom, look.palette.background, size.width, size.height]);

  // Backdrop texture, starfield and floor grid.
  useEffect(() => {
    const fg = fgRef.current;
    if (!ready || !fg) return;
    const scene = fg.scene();
    const texture = backdropTexture(look);
    scene.background = texture;

    const extras: THREE.Object3D[] = [];
    if (look.backdrop === "stars" || look.backdrop === "aurora") extras.push(starfield(look));
    if (look.backdrop === "grid" || look.backdrop === "dots") {
      const tone = mix(look.palette.background, look.palette.link, 0.9);
      const grid = new THREE.GridHelper(3000, 60, tone, tone);
      grid.position.y = -260;
      const material = grid.material as THREE.Material;
      material.transparent = true;
      material.opacity = 0.35;
      extras.push(grid);
    }
    extras.forEach((object) => scene.add(object));

    return () => {
      extras.forEach((object) => {
        scene.remove(object);
        disposeObject(object);
      });
      if (scene.background === texture) scene.background = null;
      texture.dispose();
    };
  }, [ready, look]);

  /*
   * Guards OrbitControls against a fake pointer-up.
   *
   * When a node drag ends — and every node click is a drag that did not move —
   * 3d-force-graph dispatches a synthetic `pointerup` on the document so the
   * camera controls let go. It carries pointerId 0, which OrbitControls never
   * saw go down: it removes nothing, finds the real mouse pointer still listed,
   * and reads a touch position that was never recorded, throwing "Cannot read
   * properties of undefined (reading 'x')". The real pointer-up follows on the
   * same gesture and releases the controls properly, so the fake one is
   * dropped. OrbitControls looks this handler up when a press starts, so
   * replacing it here takes effect from the next press on.
   */
  useEffect(() => {
    const fg = fgRef.current;
    if (!ready || !fg) return;
    const controls = fg.controls() as unknown as {
      _pointers?: number[];
      _onPointerUp?: (event: PointerEvent) => void;
    };
    const original = controls._onPointerUp;
    if (!original || !Array.isArray(controls._pointers)) return;
    controls._onPointerUp = (event: PointerEvent) => {
      if (!event.isTrusted && !controls._pointers?.includes(event.pointerId)) return;
      original(event);
    };
    return () => {
      controls._onPointerUp = original;
    };
  }, [ready]);

  // Camera spin.
  useEffect(() => {
    const fg = fgRef.current;
    if (!ready || !fg) return;
    const controls = fg.controls() as OrbitControls;
    controls.autoRotate = look.three.autoRotate;
    controls.autoRotateSpeed = look.three.rotateSpeed;
  }, [ready, look.three.autoRotate, look.three.rotateSpeed]);

  // Spread the forces out to the chosen spacing.
  useEffect(() => {
    const fg = fgRef.current;
    if (!ready || !fg) return;
    fg.d3Force("charge")?.strength(-140 * look.spacing);
    fg.d3Force("link")?.distance(38 * look.spacing);
    fg.d3ReheatSimulation();
  }, [ready, look.spacing, graphData]);

  const family = fontFamily(loadedFont);
  const weight = fontWeight(loadedFont);

  const nodeObject = useMemo(() => {
    const kind3d = look.three.node;
    return (node: Node3D): THREE.Object3D => {
      const colors = lookup(node);
      const scale = look.textScale * (look.overrides[node.id]?.scale ?? 1);
      const height = (TEXT_HEIGHT[node.kind] ?? TEXT_HEIGHT.concept) * scale;
      const sprite = new SpriteText(displayLabel(look, node), height, colors.text);
      sprite.fontFace = family;
      sprite.fontWeight = String(weight);
      // A thin outline in the backdrop colour keeps text legible under bloom.
      sprite.strokeWidth = 1.2;
      sprite.strokeColor = look.palette.background;
      const selected = node.id === selectedId;

      if (kind3d === "label") {
        const boxed = look.shape !== "underline";
        sprite.backgroundColor = boxed ? colors.fill : false;
        sprite.padding = boxed ? [height * 0.55, height * 0.32] : 0;
        sprite.borderWidth = selected ? height * 0.12 : boxed ? Math.max(0.15, look.borderWidth * 0.35) : 0;
        sprite.borderColor = selected ? "#ffffff" : colors.stroke;
        sprite.borderRadius =
          look.shape === "pill" || look.shape === "bubble" ? height * 0.8 : look.shape === "sharp" ? 0 : height * 0.3;
        return sprite;
      }

      const group = new THREE.Group();
      const radius = height * 0.75;
      const accent = new THREE.Color(colors.accent);
      if (kind3d === "orb") {
        const orb = new THREE.Mesh(
          new THREE.SphereGeometry(radius, 24, 16),
          new THREE.MeshBasicMaterial({ color: accent, transparent: true, opacity: 0.92 }),
        );
        group.add(orb);
      } else {
        const shell = new THREE.Mesh(
          new THREE.IcosahedronGeometry(radius * 1.2, 0),
          new THREE.MeshBasicMaterial({ color: accent, wireframe: true }),
        );
        const core = new THREE.Mesh(
          new THREE.IcosahedronGeometry(radius * 0.55, 0),
          new THREE.MeshBasicMaterial({ color: accent, transparent: true, opacity: 0.55 }),
        );
        shell.rotation.set(node.depth * 0.7, node.depth * 1.3, 0);
        group.add(shell, core);
      }
      if (selected) {
        const halo = new THREE.Mesh(
          new THREE.SphereGeometry(radius * 1.6, 16, 12),
          new THREE.MeshBasicMaterial({ color: 0xffffff, wireframe: true, transparent: true, opacity: 0.5 }),
        );
        group.add(halo);
      }
      sprite.position.y = radius + height * 0.9;
      group.add(sprite);
      return group;
    };
  }, [look, lookup, family, weight, selectedId]);

  // Rebuilt node objects come back at full opacity; put the current focus on them.
  useEffect(() => {
    if (!ready) return;
    // The library swaps the objects in on its next update, a frame later.
    const id = requestAnimationFrame(() => applyFocus3D(graphData, focus.stateRef.current));
    return () => cancelAnimationFrame(id);
    // Focus changes are applied by the hook itself; this only covers rebuilds.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, nodeObject]);

  useImperativeHandle(
    handleRef,
    (): MindmapCanvasHandle => ({
      releaseAll: () => {
        for (const node of graphData.nodes) {
          node.fx = undefined;
          node.fy = undefined;
          node.fz = undefined;
        }
        framedRef.current = false;
        fgRef.current?.d3ReheatSimulation();
      },
      viewSize: () => size,
      snapshot: async (request) => {
        const fg = fgRef.current;
        if (!fg) throw new Error("The 3D view is still loading");
        if (request.fit) fg.zoomToFit(0, 30);

        const renderer = fg.renderer() as THREE.WebGLRenderer;
        const composer = fg.postProcessingComposer();
        const previous = renderer.getPixelRatio();
        const ratio = Math.min(4, Math.max(request.width / size.width, request.height / size.height));
        const output = document.createElement("canvas");
        output.width = request.width;
        output.height = request.height;
        const ctx = output.getContext("2d");
        if (!ctx) throw new Error("Canvas is not available in this browser");

        try {
          renderer.setPixelRatio(ratio);
          composer.setPixelRatio(ratio);
          composer.render();
          const source = renderer.domElement;
          // Cover-crop the render into the requested frame.
          const scale = Math.max(request.width / source.width, request.height / source.height);
          const w = source.width * scale;
          const h = source.height * scale;
          ctx.drawImage(source, (request.width - w) / 2, (request.height - h) / 2, w, h);
        } finally {
          renderer.setPixelRatio(previous);
          composer.setPixelRatio(previous);
        }

        const logo = request.watermark ? await loadWatermarkLogo(look) : null;
        paintCaption(ctx, request.width, request.height, look, family, request.title, request.watermark, logo);
        return canvasToBlob(output);
      },
    }),
    [graphData, size, look, family],
  );

  if (graph.nodes.length === 0) {
    return (
      <div ref={containerRef} className="relative min-h-0 flex-1 overflow-hidden">
        <p className="text-label absolute inset-0 flex items-center justify-center px-4 text-center text-[12px]">
          {emptyMessage}
        </p>
      </div>
    );
  }

  const dagMode = look.three.layout === "radial" ? "radialout" : look.three.layout === "tree" ? "td" : undefined;
  const linkTone = (link: Link3D) => {
    const target = endpoint(link.target);
    return look.link.gradient && target ? lookup(target).accent : look.palette.link;
  };

  return (
    <div
      ref={containerRef}
      onPointerDownCapture={(event) => {
        pressRef.current = { at: performance.now(), type: event.pointerType };
      }}
      className="relative min-h-0 flex-1 overflow-hidden select-none [-webkit-touch-callout:none]"
      style={{ backgroundColor: look.palette.background }}
    >
      <FocusLockButton
        buttonRef={lockButtonRef}
        onPointerEnter={() => focus.hover(focus.stateRef.current.id)}
        onToggle={() => {
          const id = focus.stateRef.current.id;
          if (id) onLockChange?.(lockedId === id ? null : id);
        }}
      />

      {size.width > 0 && (
        <ForceGraph3D<Node3D, Link3D>
          ref={fgRef as React.MutableRefObject<Instance | undefined>}
          width={size.width}
          height={size.height}
          graphData={graphData}
          controlType="orbit"
          // Exports read the canvas back after rendering into it.
          rendererConfig={{ antialias: true, alpha: false, preserveDrawingBuffer: true }}
          backgroundColor={look.palette.background}
          showNavInfo={false}
          dagMode={dagMode}
          dagLevelDistance={50 * look.spacing}
          onDagError={() => {}}
          cooldownTicks={160}
          nodeThreeObject={nodeObject}
          nodeVisibility={(node) => !isHidden(look, node.id)}
          linkVisibility={(link) => {
            const s = endpoint(link.source);
            const t = endpoint(link.target);
            return !(s && isHidden(look, s.id)) && !(t && isHidden(look, t.id));
          }}
          linkColor={linkTone}
          linkOpacity={look.link.opacity * 0.85}
          linkWidth={look.link.width * 0.35}
          linkCurvature={look.link.curvature}
          linkDirectionalParticles={particlesPerLink(look, graph.links.length)}
          linkDirectionalParticleSpeed={look.link.particleSpeed}
          linkDirectionalParticleWidth={look.link.particleSize * 0.9}
          linkDirectionalParticleColor={linkTone}
          showPointerCursor={(object) =>
            Boolean(object && "kind" in object && (editing || isClickable(object as MapNode)))
          }
          onNodeHover={(node) => {
            if (pressRef.current.type !== "mouse") return;
            // Picking can still find a node the zoom has hidden; it is not there.
            const shown = node && (node as Node3D & { __threeObj?: THREE.Object3D }).__threeObj?.visible !== false;
            focus.hover(shown ? node.id : null);
          }}
          onBackgroundClick={() => focus.clear()}
          onNodeClick={(node) => {
            if ((node as Node3D & { __threeObj?: THREE.Object3D }).__threeObj?.visible === false) return;
            // On touch, a press held long enough is a focus, not a click.
            const press = pressRef.current;
            if (focusOn && press.type !== "mouse" && performance.now() - press.at >= LONG_PRESS_MS) {
              focus.hold(node.id);
              return;
            }
            if (editing) onSelect?.(node);
            else if (isClickable(node)) onNodeClick?.(node);
          }}
          onNodeDragEnd={(node) => {
            // Same as 2D: a node put somewhere by hand stays there.
            node.fx = node.x;
            node.fy = node.y;
            node.fz = node.z;
          }}
          onNodeRightClick={(node) => {
            node.fx = undefined;
            node.fy = undefined;
            node.fz = undefined;
            fgRef.current?.d3ReheatSimulation();
          }}
          onEngineStop={() => {
            if (!framedRef.current) {
              framedRef.current = true;
              fgRef.current?.zoomToFit(600, 40);
              onSettled?.();
            }
          }}
        />
      )}
    </div>
  );
}
